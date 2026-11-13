import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Manager } from "../src/manager.ts";
import type { LogRef } from "../src/storage.ts";
import { client } from "../src/tmux.ts";

const delay = () => new Promise((resolve) => setTimeout(resolve, 25));

test("journal-backed jobs finalize and support explicit read-only history", async () => {
  const root = await mkdtemp(join(tmpdir(), "pbm-manager-"));
  const refs: LogRef[] = [];
  const m = new Manager(
    "session-a",
    () => undefined,
    (ref) => {
      if (ref) refs.push(ref);
    },
    join(root, "state"),
  );
  try {
    const started = await m.run(() =>
      m.start(
        "printf 'FIRST\\n'; for ((i=0;i<350;i++)); do echo row; done; printf 'LAST\\n'; exit 7",
        process.cwd(),
      ),
    );
    assert.equal(started.state, "running");
    let seen = await m.run(() => m.inspect(started.id));
    for (let i = 0; i < 200 && seen.captureHealth !== "complete"; i++) {
      await delay();
      seen = await m.run(() => m.inspect(started.id));
    }
    const unverified = seen.state === "source_unverified";
    assert.equal(seen.state, unverified ? "source_unverified" : "exited");
    assert.equal(seen.exitCode, unverified ? undefined : 7);
    assert.match(seen.untrustedOutput.text, /LAST/);
    let cursor = { sequence: 0, offset: 0 },
      full = "";
    for (let i = 0; i < 10; i++) {
      const page = await m.run(() => m.inspect(started.id, cursor));
      full += page.untrustedOutput.text;
      cursor = page.next;
      if (!page.untrustedOutput.truncated) break;
    }
    assert.equal(full, `FIRST\n${"row\n".repeat(350)}LAST\n`);
    assert.equal(refs.length, 1);
    if (unverified) {
      await assert.rejects(
        m.run(() => m.forget(started.id)),
        /unverified/,
      );
      assert.equal((await m.run(() => m.serverStop())).stopped, true);
    } else assert.notEqual((await client(["-S", started.socket, "list-sessions"])).code, 0);
    const again = await m.run(() => m.start("printf 'NEW\\n'", process.cwd()));
    assert.notEqual(again.id, started.id);
    const historical = new Manager(
      "session-a",
      () => undefined,
      () => {},
      join(root, "state"),
    );
    try {
      assert.deepEqual(await historical.run(() => historical.jobs()), []);
      const read = await historical.run(() =>
        historical.inspectHistorical(refs[0], { sequence: 0, offset: 0 }),
      );
      assert.equal(read.state, unverified ? "lost" : "exited");
      assert.equal(read.exitCode, unverified ? undefined : 7);
      assert.match(read.untrustedOutput.text, /FIRST/);
      const wrong = new Manager(
        "session-b",
        () => undefined,
        () => {},
        join(root, "state"),
      );
      await assert.rejects(wrong.run(() => wrong.inspectHistorical(refs[0])));
      await wrong.close();
    } finally {
      await historical.close();
    }
    assert.equal((await m.run(() => m.forget(started.id))).forgotten, started.id);
  } finally {
    await m.run(() => m.serverStop()).catch(() => {});
    await m.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("stop and validation retain owned-process safety", async () => {
  const root = await mkdtemp(join(tmpdir(), "pbm-manager-"));
  const m = new Manager(
    "session",
    () => undefined,
    () => {},
    join(root, "state"),
  );
  try {
    await assert.rejects(
      m.run(() => m.start("", process.cwd())),
      /Command/,
    );
    await assert.rejects(
      m.run(() => m.inspect("../bad")),
      /Invalid job/,
    );
    const job = await m.run(() => m.start("echo READY; exec sleep 30", process.cwd()));
    const stopped = await m.run(() => m.stop(job.id));
    if (stopped.state === "capture_unverified") {
      assert.equal((await m.run(() => m.inspect(job.id))).state, "source_unverified");
      await assert.rejects(
        m.run(() => m.forget(job.id)),
        /unverified/,
      );
      assert.equal((await m.run(() => m.serverStop())).stopped, true);
    } else assert.equal(stopped.state, "cancelled");
    let seen = await m.run(() => m.inspect(job.id));
    for (let i = 0; i < 200 && seen.captureHealth !== "complete"; i++) {
      await delay();
      seen = await m.run(() => m.inspect(job.id));
    }
    assert.equal(
      seen.state,
      stopped.state === "capture_unverified" ? "source_unverified" : "cancelled",
    );
    assert.equal(seen.captureHealth, "complete");
    const history = new Manager(
      "session",
      () => undefined,
      () => {},
      join(root, "state"),
    );
    assert.equal(
      (await history.inspectHistorical(job.logRef)).state,
      stopped.state === "capture_unverified" ? "lost" : "cancelled",
    );
    await history.close();
    assert.equal((await m.run(() => m.forget(job.id))).forgotten, job.id);
  } finally {
    await m.run(() => m.serverStop()).catch(() => {});
    await m.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("stale jobs cannot control a reused pane on a new server", async () => {
  const root = await mkdtemp(join(tmpdir(), "pbm-generation-"));
  const m = new Manager(
    "session",
    () => undefined,
    () => {},
    join(root, "state"),
  );
  try {
    const old = await m.run(() => m.start("echo OLD; exec sleep 30", process.cwd()));
    const stopped = await m.run(() => m.serverStop());
    assert.equal(stopped.stopped, true);
    assert.equal(stopped.incomplete, 0);
    const closed = await m.run(() => m.inspect(old.id));
    assert.equal(closed.state, "cancelled");
    assert.equal(closed.captureHealth, "complete");
    const fresh = await m.run(() => m.start("exec sleep 30", process.cwd()));
    assert.equal(fresh.state, "running");
    await m.run(() => m.stop(old.id));
    assert.equal((await m.run(() => m.inspect(fresh.id))).state, "running");
  } finally {
    await m.run(() => m.serverStop()).catch(() => {});
    await m.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("pre-release startup failure rolls back its storage reservation", async () => {
  const { readdir } = await import("node:fs/promises");
  const { Tmux } = await import("../src/tmux.ts");
  const root = await mkdtemp(join(tmpdir(), "pbm-startup-fail-"));
  const m = new Manager(
    "session",
    () => undefined,
    () => {},
    join(root, "state"),
  );
  const original = Tmux.prototype.startCaptured;
  Tmux.prototype.startCaptured = async () => {
    throw new Error("injected pre-release failure");
  };
  try {
    await assert.rejects(
      m.run(() => m.start("echo must-not-run", process.cwd())),
      /injected pre-release failure/,
    );
    assert.deepEqual(await m.run(() => m.jobs()), []);
    assert.deepEqual(await readdir(join(root, "state", "slots")), []);
  } finally {
    Tmux.prototype.startCaptured = original;
    await m.run(() => m.serverStop()).catch(() => {});
    await m.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("failed pane termination does not claim cancellation", async () => {
  const { Tmux } = await import("../src/tmux.ts");
  const root = await mkdtemp(join(tmpdir(), "pbm-stop-fail-"));
  const m = new Manager(
    "session",
    () => undefined,
    () => {},
    join(root, "state"),
  );
  let tm: InstanceType<typeof Tmux> | undefined;
  let original: ((...args: string[]) => string[]) | undefined;
  try {
    const job = await m.run(() => m.start("trap '' INT; echo READY; exec sleep 30", process.cwd()));
    for (let i = 0; i < 100; i++) {
      if ((await m.run(() => m.inspect(job.id))).untrustedOutput.text.includes("READY")) break;
      await delay();
    }
    tm = (m as any).tm;
    assert.ok(tm);
    original = tm.args.bind(tm);
    const saved = original;
    tm.args = (...args) =>
      args[0] === "if-shell" && args.some((part) => part.startsWith("kill-pane -t "))
        ? saved("invalid-command")
        : saved(...args);
    await assert.rejects(
      m.run(() => m.stop(job.id)),
      /tmux/,
    );
    tm.args = original;
    assert.equal((await m.run(() => m.inspect(job.id))).state, "running");
  } finally {
    if (tm && original) tm.args = original;
    await m.run(() => m.serverStop()).catch(() => {});
    await m.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("unverified capture remains retryable with an explicit stop", async () => {
  const { Tmux } = await import("../src/tmux.ts");
  const root = await mkdtemp(join(tmpdir(), "pbm-verify-fail-"));
  const m = new Manager(
    "session",
    () => undefined,
    () => {},
    join(root, "state"),
  );
  let tm: InstanceType<typeof Tmux> | undefined;
  let verify: (() => Promise<boolean>) | undefined;
  try {
    const job = await m.run(() => m.start("exec sleep 30", process.cwd()));
    tm = (m as any).tm;
    assert.ok(tm);
    verify = tm.verify.bind(tm);
    tm.verify = async () => false;
    let state = "";
    for (let i = 0; i < 100 && state !== "capture_unverified"; i++) {
      await delay();
      state = (await m.run(() => m.inspect(job.id))).state;
    }
    assert.equal(state, "capture_unverified");
    await assert.rejects(
      m.run(() => m.stop(job.id)),
      /verify producer/,
    );
    tm.verify = verify;
    const result = await m.run(() => m.stop(job.id));
    if (result.state === "capture_unverified") {
      assert.equal((await m.run(() => m.inspect(job.id))).state, "source_unverified");
      await assert.rejects(
        m.run(() => m.forget(job.id)),
        /unverified/,
      );
    } else assert.equal(result.state, "cancelled");
  } finally {
    if (tm && verify) tm.verify = verify;
    await m.run(() => m.serverStop()).catch(() => {});
    await m.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("a stalled sink finishes stop as incomplete rather than draining forever", async () => {
  const { readFile } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "pbm-stalled-sink-"));
  const m = new Manager(
    "session",
    () => undefined,
    () => {},
    join(root, "state"),
  );
  let sinkPid = 0;
  try {
    const job = await m.run(() => m.start("trap '' INT; echo READY; exec sleep 30", process.cwd()));
    for (let i = 0; i < 100; i++) {
      if ((await m.run(() => m.inspect(job.id))).untrustedOutput.text.includes("READY")) break;
      await delay();
    }
    const capture = JSON.parse(
      await readFile(
        join(root, "state", "owners", job.logRef.owner, job.logRef.stream, "capture.json"),
        "utf8",
      ),
    );
    sinkPid = capture.pid;
    process.kill(sinkPid, "SIGSTOP");
    const stopped = await m.run(() => m.stop(job.id));
    assert.equal(stopped.state, "cancelled");
    assert.equal(stopped.capture, "incomplete");
    assert.equal((await m.run(() => m.inspect(job.id))).capture, "incomplete");
  } finally {
    if (sinkPid) {
      try {
        process.kill(sinkPid, "SIGCONT");
      } catch {}
    }
    await m.run(() => m.serverStop()).catch(() => {});
    await m.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("a missing private socket does not claim the owned server stopped", async () => {
  const { lstat, unlink } = await import("node:fs/promises");
  const { checked } = await import("../src/tmux.ts");
  const root = await mkdtemp(join(tmpdir(), "pbm-unlinked-socket-"));
  const m = new Manager(
    "session",
    () => undefined,
    () => {},
    join(root, "state"),
  );
  let serverPid = 0;
  try {
    const job = await m.run(() => m.start("exec sleep 30", process.cwd()));
    const pid = await checked(["-S", job.socket, "display-message", "-p", "#{pid}"]);
    serverPid = Number(pid.stdout.trim());
    assert.ok(serverPid > 1);
    await unlink(job.socket);
    const stopped = await m.run(() => m.serverStop());
    assert.equal(stopped.stopped, false);
    assert.equal(stopped.unverified, true);
    assert.equal((await m.run(() => m.inspect(job.id))).state, "capture_unverified");
    await assert.rejects(
      m.run(() => m.start("echo unsafe", process.cwd())),
      /unverified server/,
    );
    process.kill(serverPid, "SIGUSR1");
    for (let i = 0; i < 100; i++) {
      if (
        await lstat(job.socket).then(
          () => true,
          () => false,
        )
      )
        break;
      await delay();
    }
    assert.equal((await m.run(() => m.serverStop())).stopped, true);
    serverPid = 0;
  } finally {
    if (serverPid) {
      try {
        process.kill(serverPid, "SIGUSR1");
      } catch {}
    }
    await m.run(() => m.serverStop()).catch(() => {});
    await m.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("server-stop retains retryable proof evidence for every affected job", async () => {
  const { boundedIo } = await import("../src/tmux.ts");
  const root = await mkdtemp(join(tmpdir(), "pbm-proof-retry-"));
  const m = new Manager(
    "proof-retry",
    () => undefined,
    () => {},
    join(root, "state"),
  );
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reservations: Promise<unknown>[] = [];
  try {
    const first = await m.run(() => m.start("sleep 20", process.cwd()));
    const second = await m.run(() => m.start("sleep 20", process.cwd()));
    reservations = Array.from({ length: 16 }, () =>
      boundedIo(() => gate, 20).catch(() => undefined),
    );
    await Promise.all(reservations);
    const stopped = await m.run(() => m.serverStop());
    assert.equal(stopped.stopped, true);
    assert.equal(stopped.proofIncomplete, 2);
    release();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await m.run(() => m.forget(first.id))).forgotten, first.id);
    await m.close();
    const historical = new Manager(
      "proof-retry",
      () => undefined,
      () => {},
      join(root, "state"),
    );
    try {
      assert.equal((await historical.inspectHistorical(second.logRef)).proofIncomplete, true);
      assert.equal((await historical.deleteHistorical(second.logRef)).deleted, true);
    } finally {
      await historical.close();
    }
  } finally {
    release();
    await Promise.all(reservations);
    await m.run(() => m.serverStop()).catch(() => {});
    await m.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("supervisor retains exit evidence when proof publication is saturated", async () => {
  const { boundedIo, Tmux } = await import("../src/tmux.ts");
  const root = await mkdtemp(join(tmpdir(), "pbm-proof-supervisor-"));
  const m = new Manager(
    "proof-supervisor",
    () => undefined,
    () => {},
    join(root, "state"),
  );
  const original = Tmux.prototype.sourceOperation;
  let release!: () => void,
    saturated = false;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reservations: Promise<unknown>[] = [];
  Tmux.prototype.sourceOperation = async function (...args) {
    await original.apply(this, args);
    if (!saturated && args[3] === "exited" && args[4] === "kill") {
      saturated = true;
      reservations = Array.from({ length: 16 }, () =>
        boundedIo(() => gate, 20).catch(() => undefined),
      );
    }
  };
  try {
    const job = await m.run(() => m.start("sleep 0.4; exit 0", process.cwd()));
    let info: any = {};
    for (let i = 0; i < 150 && !info.proofIncomplete && info.state !== "source_unverified"; i++) {
      await delay();
      info = await m.run(() => m.inspect(job.id));
    }
    if (info.state === "source_unverified") {
      assert.equal(saturated, false);
      assert.equal(info.exitCode, undefined);
      await assert.rejects(
        m.run(() => m.forget(job.id)),
        /unverified/,
      );
      return;
    }
    assert.equal(info.proofIncomplete, true);
    release();
    await Promise.all(reservations);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await m.run(() => m.forget(job.id))).forgotten, job.id);
  } finally {
    release();
    Tmux.prototype.sourceOperation = original;
    await Promise.all(reservations);
    await m.run(() => m.serverStop()).catch(() => {});
    await m.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a stalled launch acknowledgement returns unknown without replacement stats", async () => {
  const { Tmux } = await import("../src/tmux.ts");
  const root = await mkdtemp(join(tmpdir(), "pbm-ack-timeout-"));
  const m = new Manager(
    "ack-timeout",
    () => undefined,
    () => {},
    join(root, "state"),
  );
  const original = Tmux.prototype.launchMarker;
  let release!: () => void,
    calls = 0;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  Tmux.prototype.launchMarker = async function (path) {
    calls++;
    await gate;
    return original.call(this, path);
  };
  try {
    const job = await m.run(() => m.start("sleep 20", process.cwd()));
    assert.equal(job.launch, "unknown");
    assert.equal(calls, 1);
    release();
    await m.run(() => m.serverStop());
  } finally {
    release();
    Tmux.prototype.launchMarker = original;
    await m.run(() => m.serverStop()).catch(() => {});
    await m.close();
    await rm(root, { recursive: true, force: true });
  }
});
