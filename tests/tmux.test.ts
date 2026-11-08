import { test } from "node:test";
import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { bounded, quote, sanitize } from "../src/output.ts";
import { checked, createDirectory, probe, Tmux } from "../src/tmux.ts";

test("bounded and sanitize untrusted output", () => {
  assert.equal(sanitize("a\x1b]0;secret\x07b\x1b[31mc\x00"), "abc");
  assert.equal(bounded("one\ntwo\nthree", 100, 2).text, "two\nthree");
  assert.deepEqual(bounded("ééé", 5), { text: "éé", truncated: true });
  assert.equal(quote("a'b"), "'a'\\''b'");
});
test("private server retains fast exit and asynchronous jobs", async () => {
  await probe(); const d = await createDirectory(); const tm = new Tmux(d.socket, d.dir, d.token);
  try {
    const file = join(d.dir, "test script.sh"); await writeFile(file, "echo READY; exit 7\n");
    const pane = await tm.start(file, d.dir, true); await tm.verify();
    for (let i = 0; i < 50 && (await tm.status(pane)).state === "running"; i++) await new Promise(r => setTimeout(r, 20));
    assert.deepEqual(await tm.status(pane), { state: "exited", exitCode: 7, signal: undefined });
    assert.match((await tm.capture(pane)).stdout, /READY/);
    await writeFile(file, "sleep 2\n"); const t = Date.now(); const p2 = await tm.start(file, d.dir, false); assert.ok(Date.now()-t < 1000); assert.equal((await tm.status(p2)).state, "running");
  } finally { await checked(tm.args("kill-server")).catch(() => {}); await rm(d.dir, { recursive: true, force: true }); }
});
