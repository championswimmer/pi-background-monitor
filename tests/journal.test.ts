import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readJournal, readJournalTail } from "../src/journal.ts";
import { Manager } from "../src/manager.ts";
import { writeStopProof } from "../src/proof.ts";
import { LogStorage } from "../src/storage.ts";

test("private reservations and session-bound historical references", async () => {
  const parent = await mkdtemp(join(tmpdir(), "pbm-store-"));
  const root = join(parent, "state");
  try {
    const store = new LogStorage("session-a", root);
    const [a, b] = await Promise.all([store.reserve(), store.reserve()]);
    assert.notEqual(a.ref.slot, b.ref.slot);
    assert.equal(await store.resolve(a.ref), a.dir);
    await assert.rejects(new LogStorage("session-b", root).resolve(a.ref));
    await assert.rejects(store.resolve({ ...a.ref, stream: "../escape" }));
    await store.remove(a.ref);
    await assert.rejects(store.resolve(a.ref));
    await writeFile(
      join(b.dir, "capture.json"),
      JSON.stringify({ version: 1, stream: b.ref.stream, first: 1, tail: 0, health: "failed" }),
      { mode: 0o600 },
    );
    await writeStopProof(b.dir, { version: 1, stream: b.ref.stream, state: "capture_failed" });
    const history = new Manager(
      "session-a",
      () => undefined,
      () => {},
      root,
    );
    assert.equal((await history.deleteHistorical(b.ref)).deleted, true);
    await assert.rejects(store.resolve(b.ref));
    await history.close();
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("journal reads committed frames in order and reports missing history", async () => {
  const parent = await mkdtemp(join(tmpdir(), "pbm-journal-"));
  const root = join(parent, "state");
  try {
    const store = new LogStorage("session", root);
    const { dir, ref } = await store.reserve();
    const encode = (sequence: number, text: string, start: number) => {
      const data = Buffer.from(text);
      return JSON.stringify({
        version: 1,
        stream: ref.stream,
        sequence,
        start,
        end: start + data.length,
        kind: "output",
        data: data.toString("base64"),
      });
    };
    const { TextNormalizer } = await import("../src/text.mjs");
    const checkpoint = new TextNormalizer();
    checkpoint.write(Buffer.from("old\n"));
    await writeFile(
      join(dir, "capture.json"),
      JSON.stringify({
        version: 1,
        stream: ref.stream,
        first: 2,
        tail: 3,
        health: "ready",
        firstText: checkpoint.snapshot(),
      }),
      { mode: 0o600 },
    );
    await writeFile(
      join(dir, "2.jsonl"),
      `${encode(2, "one\n", 4)}\n${encode(3, "two\n", 8)}\n{partial`,
      { mode: 0o600 },
    );
    const read = await readJournal(dir, ref.stream);
    assert.equal(read.gap, true);
    assert.equal(read.next, 3);
    assert.equal(Buffer.concat(read.frames.map((f) => f.data)).toString(), "one\ntwo\n");
    const next = await readJournal(dir, ref.stream, 2);
    assert.equal(next.gap, false);
    assert.equal(next.frames[0].data.toString(), "two\n");
    const historical = new Manager(
      "session",
      () => undefined,
      () => {},
      root,
    );
    const tail = await historical.inspectHistorical(ref);
    assert.equal(tail.untrustedOutput.text, "one\ntwo\n");
    assert.equal(tail.gap, true);
    assert.equal(tail.parserUncertain, false);
    await historical.close();
    await rm(join(dir, "2.jsonl"));
    await symlink(join(dir, "capture.json"), join(dir, "2.jsonl"));
    await assert.rejects(readJournal(dir, ref.stream));
    await rm(join(dir, "2.jsonl"));
    await writeFile(
      join(dir, "capture.json"),
      JSON.stringify({ version: 1, stream: ref.stream, first: 1, tail: 3, health: "ready" }),
      { mode: 0o600 },
    );
    await writeFile(
      join(dir, "1.jsonl"),
      `${encode(1, "one\n", 0)}\n${encode(3, "three\n", 8)}\n`,
      { mode: 0o600 },
    );
    const prefix = await readJournal(dir, ref.stream);
    assert.equal(prefix.gap, false);
    assert.equal(prefix.next, 1);
    assert.equal(Buffer.concat(prefix.frames.map((f) => f.data)).toString(), "one\n");
    const missing = await readJournal(dir, ref.stream, prefix.next);
    assert.equal(missing.gap, true);
    assert.equal(missing.next, 3);
    assert.equal(Buffer.concat(missing.frames.map((f) => f.data)).toString(), "three\n");
    assert.equal((await readJournal(dir, ref.stream, missing.next)).gap, false);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("tail reads past 12,800 small frames and forward reads hold partial UTF-8", async () => {
  const parent = await mkdtemp(join(tmpdir(), "pbm-utf8-"));
  const root = join(parent, "state");
  try {
    const store = new LogStorage("session", root);
    const { dir, ref } = await store.reserve();
    const frame = (sequence: number, start: number, data: Buffer) =>
      JSON.stringify({
        version: 1,
        stream: ref.stream,
        sequence,
        start,
        end: start + data.length,
        kind: "output",
        data: data.toString("base64"),
      });
    let lines: string[] = [];
    for (let n = 1; n <= 13001; n++) {
      lines.push(frame(n, n - 1, Buffer.from(n === 13001 ? "Z" : "x")));
      if (n % 4000 === 0 || n === 13001) {
        await writeFile(join(dir, `${n - lines.length + 1}.jsonl`), `${lines.join("\n")}\n`, {
          mode: 0o600,
        });
        lines = [];
      }
    }
    await writeFile(
      join(dir, "capture.json"),
      JSON.stringify({ version: 1, stream: ref.stream, first: 1, tail: 13001, health: "complete" }),
      { mode: 0o600 },
    );
    assert.equal((await readJournalTail(dir, ref.stream)).data.at(-1), "Z".charCodeAt(0));
    for (const start of [1, 4001, 8001, 12001]) await rm(join(dir, `${start}.jsonl`));
    await writeFile(join(dir, "1.jsonl"), `${frame(1, 0, Buffer.from([0xe2, 0x82]))}\n`, {
      mode: 0o600,
    });
    await writeFile(
      join(dir, "capture.json"),
      JSON.stringify({ version: 1, stream: ref.stream, first: 1, tail: 1, health: "ready" }),
      { mode: 0o600 },
    );
    const manager = new Manager(
      "session",
      () => undefined,
      () => {},
      root,
    );
    const tail = await manager.inspectHistorical(ref);
    assert.equal(tail.untrustedOutput.text, "");
    assert.equal(tail.pendingUtf8, true);
    assert.deepEqual(tail.next, { sequence: 0, offset: 0 });
    const first = await manager.inspectHistorical(ref, { sequence: 0, offset: 0 });
    assert.equal(first.untrustedOutput.text, "");
    assert.equal(first.pendingUtf8, true);
    await writeFile(
      join(dir, "1.jsonl"),
      `${frame(1, 0, Buffer.from([0xe2, 0x82]))}\n${frame(2, 2, Buffer.from([0xac]))}\n`,
      { mode: 0o600 },
    );
    await writeFile(
      join(dir, "capture.json"),
      JSON.stringify({ version: 1, stream: ref.stream, first: 1, tail: 2, health: "ready" }),
      { mode: 0o600 },
    );
    const second = await manager.inspectHistorical(ref, first.next);
    assert.equal(second.untrustedOutput.text, "€");
    assert.equal((await manager.inspectHistorical(ref, tail.next)).untrustedOutput.text, "€");
    const invalid = Buffer.alloc(6000, 0xff);
    await writeFile(join(dir, "1.jsonl"), `${frame(1, 0, invalid)}\n`, { mode: 0o600 });
    await writeFile(
      join(dir, "capture.json"),
      JSON.stringify({ version: 1, stream: ref.stream, first: 1, tail: 1, health: "complete" }),
      { mode: 0o600 },
    );
    const limited = await manager.inspectHistorical(ref, { sequence: 0, offset: 0 });
    assert.ok(Buffer.byteLength(limited.untrustedOutput.text) <= 16384);
    assert.equal(limited.untrustedOutput.truncated, true);
    await manager.close();
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("forward inspection preserves terminal-control state across pages", async () => {
  const parent = await mkdtemp(join(tmpdir(), "pbm-escape-page-"));
  const root = join(parent, "state");
  try {
    const store = new LogStorage("session", root);
    const { dir, ref } = await store.reserve();
    const left = Buffer.from(`${"x".repeat(5460)}\x1b`),
      right = Buffer.from("]0;SECRET\x07SAFE\n");
    const encode = (sequence: number, start: number, data: Buffer) =>
      JSON.stringify({
        version: 1,
        stream: ref.stream,
        sequence,
        start,
        end: start + data.length,
        kind: "output",
        data: data.toString("base64"),
      });
    await writeFile(
      join(dir, "1.jsonl"),
      `${encode(1, 0, left)}\n${encode(2, left.length, right)}\n`,
      { mode: 0o600 },
    );
    await writeFile(
      join(dir, "capture.json"),
      JSON.stringify({ version: 1, stream: ref.stream, first: 1, tail: 2, health: "complete" }),
      { mode: 0o600 },
    );
    const manager = new Manager(
      "session",
      () => undefined,
      () => {},
      root,
    );
    const first = await manager.inspectHistorical(ref, { sequence: 0, offset: 0 });
    const second = await manager.inspectHistorical(ref, first.next);
    assert.equal(first.untrustedOutput.text, "x".repeat(5460));
    assert.equal(second.untrustedOutput.text, "SAFE\n");
    await manager.close();
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("inspection bounds CR-rendered lines and strips controls crossing a tail cut", async () => {
  const parent = await mkdtemp(join(tmpdir(), "pbm-tail-control-"));
  const root = join(parent, "state");
  try {
    const store = new LogStorage("session", root);
    const { dir, ref } = await store.reserve();
    const manager = new Manager(
      "session",
      () => undefined,
      () => {},
      root,
    );
    const encode = (sequence: number, start: number, data: Buffer) =>
      JSON.stringify({
        version: 1,
        stream: ref.stream,
        sequence,
        start,
        end: start + data.length,
        kind: "output",
        data: data.toString("base64"),
      });
    const cr = Buffer.alloc(400, 13);
    await writeFile(join(dir, "1.jsonl"), `${encode(1, 0, cr)}\n`, { mode: 0o600 });
    await writeFile(
      join(dir, "capture.json"),
      JSON.stringify({ version: 1, stream: ref.stream, first: 1, tail: 1, health: "complete" }),
      { mode: 0o600 },
    );
    const forward = await manager.inspectHistorical(ref, { sequence: 0, offset: 0 });
    assert.ok(forward.untrustedOutput.text.split("\n").length <= 200);
    assert.equal(forward.untrustedOutput.truncated, true);
    const raw = Buffer.from(
      `${"x".repeat(1000)}\x1b]${"a".repeat(3000)}SECRET\x07${"\x1b[31m".repeat(12600)}`,
    );
    const frames: string[] = [];
    for (let start = 0, seq = 1; start < raw.length; start += 16384, seq++)
      frames.push(encode(seq, start, raw.subarray(start, start + 16384)));
    await writeFile(join(dir, "1.jsonl"), `${frames.join("\n")}\n`, { mode: 0o600 });
    await writeFile(
      join(dir, "capture.json"),
      JSON.stringify({
        version: 1,
        stream: ref.stream,
        first: 1,
        tail: frames.length,
        health: "complete",
      }),
      { mode: 0o600 },
    );
    const tail = await manager.inspectHistorical(ref);
    assert.equal(tail.untrustedOutput.text.includes("SECRET"), false);
    assert.equal(tail.untrustedOutput.truncated, true);
    await manager.close();
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("rotated inspection restores its paired parser checkpoint and rejects races", async () => {
  const { TextNormalizer } = await import("../src/text.mjs");
  const parent = await mkdtemp(join(tmpdir(), "pbm-inspection-checkpoint-"));
  const root = join(parent, "state");
  try {
    const store = new LogStorage("session", root);
    const { dir, ref } = await store.reserve();
    const parser = new TextNormalizer();
    parser.write(Buffer.concat([Buffer.from("\x1b]hidden-"), Buffer.from([0xe2, 0x82])]));
    const firstText = parser.snapshot();
    const data = Buffer.concat([Buffer.from([0xac]), Buffer.from("SECRET\x07VISIBLE\n")]);
    const frame = {
      version: 1,
      stream: ref.stream,
      sequence: 2,
      start: 10,
      end: 10 + data.length,
      kind: "output",
      data: data.toString("base64"),
    };
    await writeFile(join(dir, "2.jsonl"), `${JSON.stringify(frame)}\n`, { mode: 0o600 });
    const metadata = {
      version: 1,
      stream: ref.stream,
      first: 2,
      tail: 2,
      health: "complete",
      firstText,
    };
    await writeFile(join(dir, "capture.json"), JSON.stringify(metadata), { mode: 0o600 });
    const manager = new Manager(
      "session",
      () => undefined,
      () => {},
      root,
    );
    const tail = await manager.inspectHistorical(ref);
    assert.equal(tail.untrustedOutput.text, "VISIBLE\n");
    const forward = await manager.inspectHistorical(ref, { sequence: 0, offset: 0 });
    assert.equal(forward.untrustedOutput.text, "VISIBLE\n");
    const original = (manager as any).normalizerAt.bind(manager);
    (manager as any).normalizerAt = async (...args: unknown[]) => {
      await writeFile(
        join(dir, "capture.json"),
        JSON.stringify({ ...metadata, first: 3, tail: 3 }),
        { mode: 0o600 },
      );
      return original(...args);
    };
    await assert.rejects(manager.inspectHistorical(ref), /rotated during inspection/);
    (manager as any).normalizerAt = original;
    await writeFile(
      join(dir, "capture.json"),
      JSON.stringify({ ...metadata, firstText: undefined }),
      { mode: 0o600 },
    );
    await assert.rejects(manager.inspectHistorical(ref), /checkpoint unavailable/);
    await manager.close();
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("journal retries a rotation between metadata sampling and segment enumeration", async () => {
  const fs = (await import("node:fs/promises")).default;
  const { syncBuiltinESMExports } = await import("node:module");
  const { TextNormalizer } = await import("../src/text.mjs");
  const parent = await mkdtemp(join(tmpdir(), "pbm-rotation-race-"));
  const root = join(parent, "state");
  const original = fs.readdir;
  try {
    const store = new LogStorage("session", root);
    const { dir, ref } = await store.reserve();
    const parser = new TextNormalizer();
    const firstText = parser.snapshot();
    const encode = (sequence: number, start: number, text: string) => {
      const data = Buffer.from(text);
      return JSON.stringify({
        version: 1,
        stream: ref.stream,
        sequence,
        start,
        end: start + data.length,
        kind: "output",
        data: data.toString("base64"),
      });
    };
    await writeFile(join(dir, "1.jsonl"), `${encode(1, 0, "old\n")}\n`, { mode: 0o600 });
    await writeFile(
      join(dir, "capture.json"),
      JSON.stringify({
        version: 1,
        stream: ref.stream,
        first: 1,
        tail: 1,
        health: "ready",
        firstText,
      }),
      { mode: 0o600 },
    );
    let rotated = false;
    (fs as any).readdir = async (path: unknown, ...args: unknown[]) => {
      if (path === dir && !rotated) {
        rotated = true;
        parser.write(Buffer.from("old\n"));
        await writeFile(join(dir, "2.jsonl"), `${encode(2, 4, "new\n")}\n`, { mode: 0o600 });
        await writeFile(
          join(dir, "capture.json"),
          JSON.stringify({
            version: 1,
            stream: ref.stream,
            first: 2,
            tail: 2,
            health: "ready",
            firstText: parser.snapshot(),
          }),
          { mode: 0o600 },
        );
        await rm(join(dir, "1.jsonl"));
      }
      return (original as any)(path, ...args);
    };
    syncBuiltinESMExports();
    const page = await readJournal(dir, ref.stream, 0);
    assert.equal(rotated, true);
    assert.equal(page.first, 2);
    assert.equal(page.gap, true);
    assert.equal(page.frames[0].sequence, 2);
    assert.deepEqual(page.firstText, parser.snapshot());
  } finally {
    (fs as any).readdir = original;
    syncBuiltinESMExports();
    await rm(parent, { recursive: true, force: true });
  }
});

test("deleting a listed segment entirely before the cursor is not a live gap", async () => {
  const fs = (await import("node:fs/promises")).default;
  const { syncBuiltinESMExports } = await import("node:module");
  const parent = await mkdtemp(join(tmpdir(), "pbm-obsolete-segment-"));
  const root = join(parent, "state");
  const original = fs.readdir;
  try {
    const store = new LogStorage("session", root);
    const { dir, ref } = await store.reserve();
    const encode = (sequence: number, start: number, text: string) => {
      const data = Buffer.from(text);
      return JSON.stringify({
        version: 1,
        stream: ref.stream,
        sequence,
        start,
        end: start + data.length,
        kind: "output",
        data: data.toString("base64"),
      });
    };
    await writeFile(join(dir, "1.jsonl"), `${encode(1, 0, "a\n")}\n${encode(2, 2, "b\n")}\n`, {
      mode: 0o600,
    });
    await writeFile(join(dir, "3.jsonl"), `${encode(3, 4, "c\n")}\n`, { mode: 0o600 });
    await writeFile(
      join(dir, "capture.json"),
      JSON.stringify({ version: 1, stream: ref.stream, first: 1, tail: 3, health: "ready" }),
      { mode: 0o600 },
    );
    let removed = false;
    (fs as any).readdir = async (path: unknown, ...args: unknown[]) => {
      const names = await (original as any)(path, ...args);
      if (path === dir && !removed) {
        removed = true;
        await rm(join(dir, "1.jsonl"));
      }
      return names;
    };
    syncBuiltinESMExports();
    const page = await readJournal(dir, ref.stream, 2);
    assert.equal(removed, true);
    assert.equal(page.gap, false);
    assert.equal(page.next, 3);
    assert.equal(page.frames[0].data.toString(), "c\n");
  } finally {
    (fs as any).readdir = original;
    syncBuiltinESMExports();
    await rm(parent, { recursive: true, force: true });
  }
});
