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
    await writeFile(
      join(dir, "capture.json"),
      JSON.stringify({ version: 1, stream: ref.stream, first: 2, tail: 3, health: "ready" }),
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
