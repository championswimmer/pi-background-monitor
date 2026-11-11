import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { checked, createDirectory, Tmux } from "../src/tmux.ts";

const delay = () => new Promise((resolve) => setTimeout(resolve, 20));

test("gated capture records first and last bytes and exit status", async () => {
  const d = await createDirectory();
  const tm = new Tmux(d.socket, d.dir, d.token);
  const dir = join(d.dir, "capture #1");
  await mkdir(dir);
  try {
    const script = join(d.dir, "command #1.sh");
    await writeFile(script, "printf 'FIRST\\nLAST\\n'; exit 7\n");
    const start = await tm.startCaptured(script, d.dir, true, dir, resolve("src/capture.mjs"));
    assert.equal(start.launch, "confirmed");
    let result: { capture?: string; state?: string; exitCode?: number } = {};
    for (let i = 0; i < 300; i++) {
      await delay();
      result = JSON.parse(await readFile(join(dir, "final.json"), "utf8").catch(() => "{}"));
      if (result.capture === "complete" || result.capture === "incomplete") break;
    }
    assert.deepEqual(result, { state: "exited", exitCode: 7, capture: "complete" });
    const files = (await readdir(dir)).filter((x) => x.endsWith(".jsonl"));
    const frames = (await Promise.all(files.map((x) => readFile(join(dir, x), "utf8"))))
      .join("")
      .trim()
      .split("\n")
      .map((x) => JSON.parse(x));
    assert.equal(
      Buffer.concat(frames.map((x) => Buffer.from(x.data, "base64"))).toString(),
      "FIRST\r\nLAST\r\n",
    );
  } finally {
    await checked(tm.args("kill-server")).catch(() => {});
    await rm(d.dir, { recursive: true, force: true });
  }
});

test("a missing sink does not release the user command", async () => {
  const d = await createDirectory();
  const tm = new Tmux(d.socket, d.dir, d.token);
  const dir = join(d.dir, "capture");
  const marker = join(d.dir, "ran");
  await mkdir(dir);
  try {
    const script = join(d.dir, "command.sh");
    await writeFile(script, `touch '${marker}'\n`);
    await assert.rejects(tm.startCaptured(script, d.dir, true, dir, join(d.dir, "missing.mjs")));
    await assert.rejects(readFile(marker));
  } finally {
    await checked(tm.args("kill-server")).catch(() => {});
    await rm(d.dir, { recursive: true, force: true });
  }
});

test("sink crash fail-stops only its owned pane", async () => {
  const d = await createDirectory();
  const tm = new Tmux(d.socket, d.dir, d.token);
  const dir = join(d.dir, "capture");
  await mkdir(dir);
  try {
    const script = join(d.dir, "command.sh");
    await writeFile(script, "exec sleep 30\n");
    const { pane, launch } = await tm.startCaptured(
      script,
      d.dir,
      true,
      dir,
      resolve("src/capture.mjs"),
    );
    assert.equal(launch, "confirmed");
    const state = JSON.parse(await readFile(join(dir, "capture.json"), "utf8"));
    process.kill(state.pid, "SIGKILL");
    let final: { state?: string } = {};
    for (let i = 0; i < 300; i++) {
      await delay();
      final = JSON.parse(await readFile(join(dir, "final.json"), "utf8").catch(() => "{}"));
      if (final.state) break;
    }
    assert.equal(final.state, "capture_failed");
    assert.equal((await tm.status(pane)).state, "lost");
  } finally {
    tm.stopCaptureSupervisors();
    await checked(tm.args("kill-server")).catch(() => {});
    await rm(d.dir, { recursive: true, force: true });
  }
});

test("rotation preserves the committed oldest segment if the new segment fails", async () => {
  const d = await createDirectory();
  try {
    const dir = join(d.dir, "capture");
    await mkdir(dir);
    const runtime = join(d.dir, "fault.mjs");
    const source = await readFile(resolve("src/capture.mjs"), "utf8");
    const modified = source
      .replace("const MAX_SEGMENT = 1024 * 1024;", "const MAX_SEGMENT = 32 * 1024;")
      .replace(
        "await file.sync();",
        'if (segments.length > 8) throw new Error("injected failure"); await file.sync();',
      );
    assert.notEqual(modified, source);
    await writeFile(runtime, modified);
    const sink = spawn(process.execPath, [runtime, dir, "nonce", "stream"], {
      stdio: ["pipe", "ignore", "ignore"],
    });
    sink.stdin.on("error", () => {});
    sink.stdin.end(Buffer.alloc(256 * 1024, 97));
    const code = await new Promise((resolve) => sink.on("close", resolve));
    assert.equal(code, 1);
    const state = JSON.parse(await readFile(join(dir, "capture.json"), "utf8"));
    assert.equal(state.health, "failed");
    assert.equal(state.first, 1);
    assert.ok(state.tail > 0);
    assert.ok((await readdir(dir)).includes("1.jsonl"));
  } finally {
    await rm(d.dir, { recursive: true, force: true });
  }
});

test("a sink becoming ready after the startup deadline never releases the gate", async () => {
  const d = await createDirectory();
  const tm = new Tmux(d.socket, d.dir, d.token);
  const dir = join(d.dir, "capture");
  await mkdir(dir);
  try {
    const script = join(d.dir, "command.sh");
    const marker = join(d.dir, "ran");
    const runtime = join(d.dir, "delayed.mjs");
    const source = await readFile(resolve("src/capture.mjs"), "utf8");
    const delayed = source.replace(
      "await segment();",
      "await new Promise((resolve) => setTimeout(resolve, 6500)); await segment();",
    );
    assert.notEqual(delayed, source);
    await writeFile(runtime, delayed);
    await writeFile(script, `touch '${marker}'\n`);
    await assert.rejects(tm.startCaptured(script, d.dir, true, dir, runtime));
    await new Promise((resolve) => setTimeout(resolve, 1800));
    await assert.rejects(readFile(marker));
  } finally {
    tm.stopCaptureSupervisors();
    await checked(tm.args("kill-server")).catch(() => {});
    await rm(d.dir, { recursive: true, force: true });
  }
});

test("a drain failure retains the real exit status", async () => {
  const d = await createDirectory();
  const tm = new Tmux(d.socket, d.dir, d.token);
  const dir = join(d.dir, "capture");
  await mkdir(dir);
  const args = tm.args.bind(tm);
  try {
    const script = join(d.dir, "command.sh");
    await writeFile(script, "exit 7\n");
    const { pane } = await tm.startCaptured(script, d.dir, true, dir, resolve("src/capture.mjs"));
    tm.args = (...value: string[]) =>
      value[0] === "kill-pane" ? args("invalid-command") : args(...value);
    let final: { state?: string; capture?: string; exitCode?: number } = {};
    for (let i = 0; i < 300; i++) {
      await delay();
      final = JSON.parse(await readFile(join(dir, "final.json"), "utf8").catch(() => "{}"));
      if (final.capture === "incomplete") break;
    }
    assert.equal(final.state, "exited");
    assert.equal(final.exitCode, 7);
    assert.equal(final.capture, "incomplete");
    assert.equal((tm.captureResult(pane) as { exitCode?: number }).exitCode, 7);
  } finally {
    tm.args = args;
    tm.stopCaptureSupervisors();
    await checked(tm.args("kill-server")).catch(() => {});
    await rm(d.dir, { recursive: true, force: true });
  }
});

test("a visible release followed by a write failure remains tracked", async () => {
  const d = await createDirectory();
  const tm = new Tmux(d.socket, d.dir, d.token);
  const dir = join(d.dir, "capture");
  await mkdir(dir);
  try {
    const marker = join(d.dir, "ran");
    const script = join(d.dir, "command.sh");
    await writeFile(script, `touch '${marker}'\n`);
    tm.releaseCaptureGate = async (path) => {
      await writeFile(path, "", { mode: 0o600, flag: "wx" });
      throw new Error("injected failure after create");
    };
    const result = await tm.startCaptured(script, d.dir, true, dir, resolve("src/capture.mjs"));
    assert.equal(result.launch, "unknown");
    let final: { state?: string; capture?: string } = {};
    for (let i = 0; i < 300; i++) {
      await delay();
      final = JSON.parse(await readFile(join(dir, "final.json"), "utf8").catch(() => "{}"));
      if (final.capture === "complete") break;
    }
    assert.equal(final.state, "exited");
    assert.equal(final.capture, "complete");
    await readFile(marker);
    assert.ok(tm.captureResult(result.pane));
  } finally {
    tm.stopCaptureSupervisors();
    await checked(tm.args("kill-server")).catch(() => {});
    await rm(d.dir, { recursive: true, force: true });
  }
});
