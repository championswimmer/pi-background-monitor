import assert from "node:assert/strict";
import { readFile, rm, symlink, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { Manager } from "../src/manager.ts";
import { checked } from "../src/tmux.ts";

test("jobs detach, recover for the same session, and stop only owned server", async () => {
  let locator: unknown;
  let m = new Manager(
    "test-session",
    () => locator,
    (x) => {
      locator = x;
    },
  );
  try {
    const start = await m.run(() => m.start("echo READY; sleep 3; exit 7", process.cwd()));
    assert.match(start.id, /^[a-f0-9]{24}$/);
    assert.match(start.attach, /^tmux -S /);
    let seen = await m.run(() => m.inspect(start.id));
    const deadline = Date.now() + 2000;
    while (
      (!("untrustedOutput" in seen) || !seen.untrustedOutput?.text.includes("READY")) &&
      Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 25));
      seen = await m.run(() => m.inspect(start.id));
    }
    assert.equal(seen.state, "running");
    assert.ok("untrustedOutput" in seen);
    assert.match(seen.untrustedOutput!.text, /READY/);
    const contender = new Manager(
      "test-session",
      () => locator,
      () => {},
    );
    await assert.rejects(
      contender.run(() => contender.jobs()),
      /lock/,
    );
    await contender.close();
    const wrong = new Manager(
      "other-session",
      () => locator,
      () => {},
    );
    await assert.rejects(
      wrong.run(() => wrong.jobs()),
      /locator/,
    );
    await wrong.close();
    await m.close();
    m = new Manager(
      "test-session",
      () => locator,
      (x) => {
        locator = x;
      },
    );
    assert.equal((await m.run(() => m.jobs())).length, 1);
    assert.equal((await m.run(() => m.stop(start.id))).state, "cancelled");
    const final = await m.run(() => m.inspect(start.id));
    assert.equal(final.state, "cancelled");
    assert.ok("untrustedOutput" in final);
    assert.match(final.untrustedOutput!.text, /READY/);
    assert.equal((await m.run(() => m.forget(start.id))).forgotten, start.id);
    assert.equal((await m.run(() => m.serverStop())).stopped, true);
    assert.equal(locator, null);
  } finally {
    await m.run(() => m.serverStop()).catch(() => {});
    await m.close();
  }
});

test("command and job validation fails before execution", async () => {
  const m = new Manager(
    "test",
    () => undefined,
    () => {},
  );
  try {
    await assert.rejects(
      m.run(() => m.start("", process.cwd())),
      /Command/,
    );
    await assert.rejects(
      m.run(() => m.inspect("../../bad")),
      /Invalid job/,
    );
  } finally {
    await m.close();
  }
});

test("missing registry directory clears locator and allows a new server", async () => {
  let locator: any = { session: "test", dir: "/tmp/pbm-Ab12Cd", token: "a".repeat(48) };
  const records: unknown[] = [];
  // Ensure this specific path is missing without ever removing an existing path.
  const { mkdtemp } = await import("node:fs/promises");
  const missing = await mkdtemp("/tmp/pbm-");
  await rm(missing, { recursive: true });
  locator.dir = missing;
  const m = new Manager(
    "test",
    () => locator,
    (x) => {
      locator = x;
      records.push(x);
    },
  );
  try {
    assert.deepEqual(await m.run(() => m.serverStop()), { stopped: false });
    assert.equal(locator, null);
    locator = { session: "test", dir: missing, token: "a".repeat(48) };
    const started = await m.run(() => m.start("sleep 10", process.cwd()));
    assert.ok(started.id);
    assert.equal(records.filter((x) => x === null).length, 2);
    assert.notEqual(locator.dir, missing);
  } finally {
    await m.run(() => m.serverStop()).catch(() => {});
    await m.close();
  }
});

test("unsafe locator symlink is not treated as missing", async () => {
  const { mkdtemp } = await import("node:fs/promises");
  const path = await mkdtemp("/tmp/pbm-");
  await rm(path, { recursive: true });
  await symlink("/nonexistent", path);
  let tombstoned = false;
  const m = new Manager(
    "test",
    () => ({ session: "test", dir: path, token: "a".repeat(48) }),
    () => {
      tombstoned = true;
    },
  );
  try {
    await assert.rejects(
      m.run(() => m.serverStop()),
      /Unsafe background directory/,
    );
    assert.equal(tombstoned, false);
  } finally {
    await m.close();
    await unlink(path);
  }
});

test("missing pane is lost even while another pane keeps the server alive", async () => {
  let locator: any;
  const m = new Manager(
    "test",
    () => locator,
    (x) => {
      locator = x;
    },
  );
  try {
    const first = await m.run(() => m.start("sleep 30", process.cwd()));
    const second = await m.run(() => m.start("sleep 30", process.cwd()));
    const registry = JSON.parse(
      await readFile(join(dirname(first.socket), "registry.json"), "utf8"),
    );
    const pane = registry.jobs.find((j: any) => j.id === first.id).pane;
    await checked(["-S", first.socket, "kill-pane", "-t", pane]);
    const jobs = await m.run(() => m.jobs());
    assert.equal(jobs.find((j) => j.id === first.id)?.state, "lost");
    assert.equal(jobs.find((j) => j.id === second.id)?.state, "running");
    assert.deepEqual(await m.run(() => m.inspect(first.id)), { id: first.id, state: "lost" });
  } finally {
    await m.run(() => m.serverStop()).catch(() => {});
    await m.close();
  }
});

test("an active controller recovers if its metadata directory disappears", async () => {
  let locator: any;
  const m = new Manager(
    "test",
    () => locator,
    (x) => {
      locator = x;
    },
  );
  try {
    const first = await m.run(() => m.start("sleep 30", process.cwd()));
    await checked(["-S", first.socket, "kill-server"]);
    await rm(dirname(first.socket), { recursive: true });
    assert.deepEqual(await m.run(() => m.serverStop()), { stopped: false });
    assert.equal(locator, null);
    const next = await m.run(() => m.start("sleep 30", process.cwd()));
    assert.notEqual(next.socket, first.socket);
  } finally {
    await m.run(() => m.serverStop()).catch(() => {});
    await m.close();
  }
});

test("more than eight retained jobs survive recovery", async () => {
  let locator: unknown;
  let m = new Manager(
    "many-jobs",
    () => locator,
    (x) => {
      locator = x;
    },
  );
  try {
    for (let i = 0; i < 9; i++) await m.run(() => m.start("sleep 30", process.cwd()));
    await m.close();
    m = new Manager(
      "many-jobs",
      () => locator,
      (x) => {
        locator = x;
      },
    );
    assert.equal((await m.run(() => m.jobs())).length, 9);
  } finally {
    await m.run(() => m.serverStop()).catch(() => {});
    await m.close();
  }
});
