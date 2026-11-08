import { test } from "node:test";
import assert from "node:assert/strict";
import { Manager } from "../src/manager.ts";

test("jobs detach, recover for the same session, and stop only owned server", async () => {
  let locator: unknown; let m = new Manager("test-session", () => locator, x => { locator = x; });
  try {
    const start = await m.run(() => m.start("echo READY; sleep 3; exit 7", process.cwd()));
    assert.match(start.id, /^[a-f0-9]{24}$/); assert.match(start.attach, /^tmux -S /);
    const seen = await m.run(() => m.inspect(start.id)); assert.equal(seen.state, "running"); assert.ok("untrustedOutput" in seen); assert.match(seen.untrustedOutput!.text, /READY/);
    const contender = new Manager("test-session", () => locator, () => {});
    await assert.rejects(contender.run(() => contender.jobs()), /lock/); await contender.close();
    const wrong = new Manager("other-session", () => locator, () => {});
    await assert.rejects(wrong.run(() => wrong.jobs()), /locator/); await wrong.close();
    await m.close(); m = new Manager("test-session", () => locator, x => { locator = x; });
    assert.equal((await m.run(() => m.jobs())).length, 1);
    assert.equal((await m.run(() => m.stop(start.id))).state, "cancelled");
    assert.equal((await m.run(() => m.forget(start.id))).forgotten, start.id);
    assert.equal((await m.run(() => m.serverStop())).stopped, true);
    assert.equal(locator, null);
  } finally { await m.run(() => m.serverStop()).catch(() => {}); await m.close(); }
});

test("command and job validation fails before execution", async () => {
  const m = new Manager("test", () => undefined, () => {});
  try { await assert.rejects(m.run(() => m.start("", process.cwd())), /Command/); await assert.rejects(m.run(() => m.inspect("../../bad")), /Invalid job/); }
  finally { await m.close(); }
});
