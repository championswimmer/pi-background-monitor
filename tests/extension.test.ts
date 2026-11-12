import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import extension from "../src/index.ts";
import { checked, Tmux } from "../src/tmux.ts";

// Background schedulers are unref'ed; keep these waits alive and bounded in isolation.
async function waitForBackground(promise: Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Background operation did not start")), 5000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const sockets = new Set<string>();
const previousStateHome = process.env.XDG_STATE_HOME;
let testStateHome = "";
function track(value: any) {
  if (typeof value?.socket === "string" && /^\/tmp\/pbm-[A-Za-z0-9]{6}\/s$/.test(value.socket))
    sockets.add(value.socket);
  return value;
}
beforeEach(async () => {
  testStateHome = await mkdtemp(join(tmpdir(), "pbm-extension-"));
  process.env.XDG_STATE_HOME = testStateHome;
});
afterEach(async () => {
  for (const socket of sockets) {
    const dir = dirname(socket);
    const config = await readFile(join(dir, "tmux.conf"), "utf8").catch(() => "");
    const token = /@pbm_owner ([a-f0-9]{48})/.exec(config)?.[1];
    if (!token) continue;
    const tm = new Tmux(socket, dir, token);
    const verified = await tm.verify().catch(() => undefined);
    if (verified === true) await checked(tm.args("kill-server")).catch(() => {});
    if (verified !== undefined) await rm(dir, { recursive: true, force: true });
  }
  sockets.clear();
  await rm(testStateHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = previousStateHome;
});

test("system prompt provides bounded background monitor guidance only when available", () => {
  const events = new Map<string, any>();
  extension({
    registerTool: () => {},
    registerCommand: () => {},
    on: (name: string, handler: any) => events.set(name, handler),
  } as any);
  const options = {
    selectedTools: ["bgmon_start"],
    sections: { existing: "preserve me" } as Record<string, string>,
  };
  const handler = events.get("before_agent_start");
  handler({ systemPromptOptions: options });
  const guidance = options.sections.background_monitor;
  assert.match(guidance, /dev servers.*log streams.*builds.*test suites/);
  assert.match(guidance, /survive Pi shutdown/);
  assert.match(guidance, /untrusted/);
  assert.match(guidance, /retention or capture failures can create gaps/);
  // Pi wraps custom sections in opening and closing tags.
  assert.ok(guidance.split("\n").length + 2 <= 5);
  handler({ systemPromptOptions: options });
  assert.equal(options.sections.background_monitor, guidance);
  options.selectedTools = ["bgmon_watch"];
  handler({ systemPromptOptions: options });
  assert.match(options.sections.background_monitor, /any, literal contains, regex/);
  assert.match(options.sections.background_monitor, /i\/u flags/);
  options.selectedTools = ["bgmon_start", "bgmon_watch"];
  handler({ systemPromptOptions: options });
  assert.equal(options.sections.background_monitor.split("\n").length, 5);
  options.selectedTools = [];
  handler({ systemPromptOptions: options });
  assert.deepEqual(options.sections, { existing: "preserve me" });
});

test("watch wakes only on selected event, not routine output; shutdown detaches", async () => {
  const tools = new Map<string, any>(),
    events = new Map<string, any>(),
    entries: any[] = [],
    messages: any[] = [];
  const pi: any = {
    registerTool: (t: any) => tools.set(t.name, t),
    on: (e: string, f: any) => events.set(e, f),
    registerCommand: () => {},
    appendEntry: (customType: string, data: unknown) =>
      entries.push({ type: "custom", customType, data }),
    sendMessage: (...args: unknown[]) => messages.push(args),
  };
  const ctx: any = {
    cwd: process.cwd(),
    hasUI: false,
    isIdle: () => true,
    sessionManager: { getSessionId: () => "test", getEntries: () => entries },
    ui: { notify: () => {} },
  };
  extension(pi);
  await events.get("session_start")({}, ctx);
  const execute = async (name: string, p: unknown) =>
    track((await tools.get(name).execute("call", p, undefined, undefined, ctx)).details);
  try {
    const start = await execute("bgmon_start", {
      command: "sleep 1; echo SECRET_READY; sleep 3",
    });
    assert.ok(start.id, JSON.stringify(start));
    const watch = await execute("bgmon_watch", {
      action: "add",
      monitorId: start.id,
      kind: "contains",
      pattern: "SECRET_READY",
      delivery: "wake",
    });
    assert.ok(watch.id);
    const deadline = Date.now() + 6000;
    while (!messages.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.equal(messages.length, 1);
    assert.doesNotMatch(messages[0][0].content, /SECRET_READY/);
    assert.deepEqual(messages[0][1], { deliverAs: "followUp", triggerTurn: true });
  } finally {
    await execute("bgmon_control", { action: "server_stop" });
    await events.get("session_shutdown")({}, ctx);
  }
});

test("exit watch reports a lost pane while another job remains alive", async () => {
  const tools = new Map<string, any>(),
    events = new Map<string, any>(),
    entries: any[] = [],
    messages: any[] = [];
  const pi: any = {
    registerTool: (t: any) => tools.set(t.name, t),
    on: (e: string, f: any) => events.set(e, f),
    registerCommand: () => {},
    appendEntry: (customType: string, data: unknown) =>
      entries.push({ type: "custom", customType, data }),
    sendMessage: (...args: unknown[]) => messages.push(args),
  };
  const ctx: any = {
    cwd: process.cwd(),
    hasUI: false,
    isIdle: () => true,
    sessionManager: { getSessionId: () => "lost-watch", getEntries: () => entries },
    ui: { notify: () => {} },
  };
  extension(pi);
  await events.get("session_start")({}, ctx);
  const execute = async (name: string, p: unknown) =>
    track((await tools.get(name).execute("call", p, undefined, undefined, ctx)).details);
  try {
    const first = await execute("bgmon_start", { command: "sleep 30" });
    const second = await execute("bgmon_start", { command: "sleep 30" });
    assert.ok(first.id);
    assert.ok(second.id);
    const watch = await execute("bgmon_watch", {
      action: "add",
      monitorId: first.id,
      kind: "exit",
      delivery: "wake",
    });
    assert.ok(watch.id);
    const panes = await checked(["-S", first.socket, "list-panes", "-a", "-F", "#{pane_id}"]);
    await checked(["-S", first.socket, "kill-pane", "-t", panes.stdout.trim().split("\n")[0]]);
    const deadline = Date.now() + 6000;
    while (!messages.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.equal(messages.length, 1);
    assert.match(messages[0][0].content, /exit, lost/);
    assert.equal((await execute("bgmon_inspect", { id: first.id })).state, "lost");
    assert.equal(
      (await execute("bgmon_inspect", {})).find((j: any) => j.id === second.id).state,
      "running",
    );
  } finally {
    await execute("bgmon_control", { action: "server_stop" });
    await events.get("session_shutdown")({}, ctx);
  }
});

function runtime(session: string, entries: any[] = []) {
  const tools = new Map<string, any>(),
    events = new Map<string, any>(),
    commands = new Map<string, any>(),
    notices: string[] = [],
    messages: any[] = [];
  const pi: any = {
    registerTool: (t: any) => tools.set(t.name, t),
    on: (e: string, f: any) => events.set(e, f),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    appendEntry: (customType: string, data: unknown) =>
      entries.push({ type: "custom", customType, data }),
    sendMessage: (...args: unknown[]) => messages.push(args),
  };
  const ctx: any = {
    cwd: process.cwd(),
    hasUI: false,
    isIdle: () => true,
    sessionManager: { getSessionId: () => session, getEntries: () => entries },
    ui: { notify: (text: string) => notices.push(text) },
  };
  extension(pi);
  return {
    entries,
    messages,
    tools,
    commands,
    notices,
    ctx,
    command: (name: string, args: string) => commands.get(name).handler(args, ctx),
    start: () => events.get("session_start")({}, ctx),
    close: () => events.get("session_shutdown")({}, ctx),
    messageEnd: (message: unknown) => events.get("message_end")({ message }, ctx),
    beforeAgent: (messageType = "user") =>
      events.get("before_agent_start")(
        { messageType, systemPromptOptions: { selectedTools: [], sections: {} } },
        ctx,
      ),
    call: async (name: string, p: unknown) =>
      track((await tools.get(name).execute("call", p, undefined, undefined, ctx)).details),
  };
}

test("shared identities and subscriptions end with the live process binding", async () => {
  const a = runtime("owner-shared"),
    b = runtime("subscriber-shared"),
    c = runtime("other-shared");
  await a.start();
  await b.start();
  await c.start();
  let id = "";
  try {
    assert.deepEqual(
      [...a.tools.keys()],
      ["bgmon_start", "bgmon_inspect", "bgmon_control", "bgmon_watch", "bgmon_events"],
    );
    const job = await a.call("bgmon_start", {
      command: "sleep 2; echo SHARED_SECRET; sleep 30",
    });
    id = job.id;
    assert.ok(id, JSON.stringify(job));
    assert.ok((await b.call("bgmon_inspect", {})).some((j: any) => j.id === id));
    assert.equal((await b.call("bgmon_inspect", { id })).state, "running");
    const watch1 = await b.call("bgmon_watch", {
      action: "add",
      monitorId: id,
      kind: "contains",
      pattern: "SHARED_SECRET",
      delivery: "wake",
    });
    const watch2 = await c.call("bgmon_watch", {
      action: "add",
      monitorId: id,
      kind: "contains",
      pattern: "SHARED_SECRET",
      delivery: "nextTurn",
    });
    const watch3 = await c.call("bgmon_watch", {
      action: "add",
      monitorId: id,
      kind: "contains",
      pattern: "SHARED_SECRET",
      delivery: "ui",
    });
    assert.ok(watch1.id && watch2.id && watch3.id);
    assert.match(
      (await c.call("bgmon_watch", { action: "remove", watchId: watch1.id })).error,
      /Unknown watch/,
    );
    assert.equal(
      (
        await b.call("bgmon_watch", {
          action: "update",
          watchId: watch1.id,
          ttlSeconds: 30,
        })
      ).state,
      "active",
    );
    await a.close();
    const deadline = Date.now() + 7000;
    while (
      (!b.messages.length ||
        (await c.call("bgmon_events", { action: "list" })).events.length < 2) &&
      Date.now() < deadline
    )
      await new Promise((r) => setTimeout(r, 50));
    assert.equal(b.messages.length, 1);
    assert.equal(c.messages.length, 0);
    assert.doesNotMatch(b.messages[0][0].content, /SHARED_SECRET/);
    const nextMessage = c.beforeAgent("custom")?.message;
    assert.ok(nextMessage);
    assert.doesNotMatch(nextMessage.content, /SHARED_SECRET/);
    const bEvents = await b.call("bgmon_events", { action: "list" });
    const cEvents = await c.call("bgmon_events", { action: "list" });
    assert.deepEqual(
      bEvents.events.map((e: any) => e.watchId),
      [watch1.id],
    );
    assert.deepEqual(
      new Set(cEvents.events.map((e: any) => e.watchId)),
      new Set([watch2.id, watch3.id]),
    );
    assert.equal(c.notices.length, 0); // UI-only events remain visible in headless sessions.
    assert.doesNotMatch(JSON.stringify(cEvents), /SHARED_SECRET/);
    assert.equal(bEvents.delivery.wake.inFlight, true);
    c.messageEnd({ role: "custom", ...nextMessage });
    assert.equal(
      (await c.call("bgmon_events", { action: "list" })).delivery.nextTurn.inFlight,
      false,
    );
    assert.equal((await b.call("bgmon_events", { action: "clear" })).cleared, 1);
    assert.equal((await b.call("bgmon_events", { action: "list" })).delivery.wake.inFlight, true);
    await b.start(); // Replacement starts empty even without an earlier shutdown callback.
    b.messageEnd({ role: "custom", ...b.messages[0][0] });
    assert.deepEqual((await b.call("bgmon_events", { action: "list" })).events, []);
    assert.deepEqual(await b.call("bgmon_watch", { action: "list" }), []);
    assert.equal((await c.call("bgmon_events", { action: "list" })).events.length, 2);
    assert.equal((await c.call("bgmon_inspect", { id })).state, "running");
    await b.close();
    await c.close();
    const recovered = runtime("owner-shared", a.entries);
    await recovered.start();
    try {
      assert.deepEqual(await recovered.call("bgmon_inspect", {}), []);
      assert.equal(
        (await recovered.call("bgmon_inspect", { logRef: job.logRef })).state,
        "unknown",
      );
      assert.deepEqual(await recovered.call("bgmon_watch", { action: "list" }), []);
      id = "";
    } finally {
      await recovered.close();
    }
  } finally {
    if (id) {
      const cleanup = runtime("owner-shared", a.entries);
      await cleanup.start();
      await cleanup.call("bgmon_control", { action: "server_stop", id });
      await cleanup.call("bgmon_control", { action: "server_stop" });
      await cleanup.close();
    }
    await a.close();
    await b.close();
    await c.close();
  }
});

test("watch limits and stale shutdown delivery", async () => {
  const a = runtime("watch-limit");
  await a.start();
  try {
    const job = await a.call("bgmon_start", { command: "sleep 1; echo TARGET; sleep 15" });
    assert.ok(job.id);
    for (let i = 0; i < 8; i++)
      assert.ok(
        (
          await a.call("bgmon_watch", {
            action: "add",
            monitorId: job.id,
            kind: "contains",
            pattern: "TARGET",
            delivery: "wake",
          })
        ).id,
      );
    assert.match(
      (await a.call("bgmon_watch", { action: "add", monitorId: job.id, kind: "exit" })).error,
      /Maximum 8/,
    );
    const invalid = await a.call("bgmon_watch", {
      action: "update",
      watchId: (await a.call("bgmon_watch", { action: "list" }))[0].id,
      ttlSeconds: 604801,
    });
    assert.match(invalid.error, /TTL/);
    await a.close();
    await new Promise((r) => setTimeout(r, 1800));
    assert.equal(a.messages.length, 0);
    const reopened = runtime("watch-limit", a.entries);
    await reopened.start();
    try {
      assert.deepEqual(await reopened.call("bgmon_watch", { action: "list" }), []);
      await reopened.call("bgmon_control", { action: "server_stop" });
    } finally {
      await reopened.close();
    }
  } finally {
    await a.close();
  }
});

test("Pi loader independently reloads extension factories using the same process broker", async () => {
  const { resolve } = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const loaderPath = pathToFileURL(
    resolve("node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js"),
  ).href;
  const { loadExtensions } = await import(loaderPath);
  const key = Symbol.for("pi-background-monitor:broker:v2");
  const before = (globalThis as any)[key];
  assert.ok(before);
  const a = await loadExtensions([resolve("src/index.ts")], process.cwd());
  const b = await loadExtensions([resolve("src/index.ts")], process.cwd());
  assert.deepEqual(a.errors, []);
  assert.deepEqual(b.errors, []);
  assert.deepEqual(
    [...a.extensions[0].tools.keys()],
    ["bgmon_start", "bgmon_inspect", "bgmon_control", "bgmon_watch", "bgmon_events"],
  );
  assert.deepEqual(
    [...b.extensions[0].tools.keys()],
    ["bgmon_start", "bgmon_inspect", "bgmon_control", "bgmon_watch", "bgmon_events"],
  );
  assert.equal((globalThis as any)[key], before);
  function loadedRuntime(loaded: any, session: string) {
    const entries: any[] = [],
      messages: any[] = [];
    loaded.runtime.appendEntry = (customType: string, data: unknown) =>
      entries.push({ type: "custom", customType, data });
    loaded.runtime.sendMessage = (...args: unknown[]) => messages.push(args);
    const ctx = {
      cwd: process.cwd(),
      hasUI: false,
      isIdle: () => true,
      sessionManager: { getSessionId: () => session, getEntries: () => entries },
      ui: { notify: () => {} },
    };
    const ext = loaded.extensions[0];
    return {
      messages,
      start: async () => {
        for (const fn of ext.handlers.get("session_start")) await fn({}, ctx);
      },
      close: async () => {
        for (const fn of ext.handlers.get("session_shutdown")) await fn({}, ctx);
      },
      call: async (name: string, p: unknown) =>
        (await ext.tools.get(name).definition.execute("call", p, undefined, undefined, ctx))
          .details,
    };
  }
  const first = loadedRuntime(a, "loader-first"),
    second = loadedRuntime(b, "loader-second");
  await first.start();
  await second.start();
  let job: any;
  try {
    job = await first.call("bgmon_start", { command: "sleep 2; echo LOADER_READY; sleep 20" });
    assert.ok(job.id, JSON.stringify(job));
    assert.equal((await second.call("bgmon_inspect", { id: job.id })).state, "running");
    const watch = await second.call("bgmon_watch", {
      action: "add",
      monitorId: job.id,
      kind: "contains",
      pattern: "LOADER_READY",

      delivery: "wake",
    });
    assert.ok(watch.id, JSON.stringify(watch));
    await first.close();
    const deadline = Date.now() + 7000;
    while (!second.messages.length && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 50));
    assert.equal(second.messages.length, 1);
    assert.doesNotMatch(second.messages[0][0].content, /LOADER_READY/);
    assert.equal((await second.call("bgmon_inspect", { id: job.id })).state, "running");
    assert.equal(
      (await second.call("bgmon_control", { action: "server_stop", id: job.id })).stopped,
      true,
    );
  } finally {
    if (job?.id) await second.call("bgmon_control", { action: "server_stop", id: job.id });
    await first.close();
    await second.close();
  }
});

test("last close racing a new session detaches control but preserves explicit log inspection", async () => {
  const a = runtime("race-owner");
  await a.start();
  const job = await a.call("bgmon_start", { command: "sleep 20" });
  assert.ok(job.id);
  const closing = a.close();
  const b = runtime("race-owner", a.entries);
  await b.start();
  try {
    assert.deepEqual(await b.call("bgmon_inspect", {}), []);
    const history = await b.call("bgmon_inspect", { logRef: job.logRef });
    assert.equal(history.state, "unknown");
    assert.equal(history.logRef.stream, job.logRef.stream);
    const panes = await checked(["-S", job.socket, "list-panes", "-a", "-F", "#{pane_id}"]);
    assert.ok(panes.stdout.trim(), "detaching leaves the job running");
    await closing;
  } finally {
    await b.close();
    await closing;
  }
});

test("obsolete locator is ignored and cannot block shared identities", async () => {
  const a = runtime("healthy-owner"),
    b = runtime("bad-locator");
  await a.start();
  await b.start();
  try {
    const job = await a.call("bgmon_start", { command: "sleep 20" });
    assert.ok(job.id);
    const watch = await b.call("bgmon_watch", { action: "add", monitorId: job.id, kind: "exit" });
    assert.ok(watch.id);
    b.entries.push({
      type: "custom",
      customType: "pi-background-monitor:locator:v1",
      data: { session: "bad-locator", locator: { invalid: true } },
    });
    assert.ok(Array.isArray(await b.call("bgmon_inspect", {})));
    assert.equal((await b.call("bgmon_inspect", { id: job.id })).state, "running");
    assert.equal(
      (await b.call("bgmon_watch", { action: "update", watchId: watch.id, ttlSeconds: 4 })).state,
      "active",
    );
    assert.equal(
      (await b.call("bgmon_watch", { action: "remove", watchId: watch.id })).removed,
      true,
    );
    assert.equal(
      (await b.call("bgmon_control", { action: "server_stop", id: job.id })).stopped,
      true,
    );
  } finally {
    await a.call("bgmon_control", { action: "server_stop" });
    await a.close();
    await b.close();
  }
});

test("shared monitor capacity frees a slot when a retained job is forgotten", async () => {
  const owners = Array.from({ length: 8 }, (_, i) => runtime(`capacity-owner-${i}`));
  const extra = runtime("capacity-extra");
  const ids: string[] = [];
  try {
    for (const owner of owners) {
      await owner.start();
      for (let j = 0; j < 8; j++) {
        const job = await owner.call("bgmon_start", { command: "exit 0" });
        assert.ok(job.id, JSON.stringify(job));
        assert.equal(job.state, "running", JSON.stringify(job));
        ids.push(job.id);
      }
    }
    await extra.start();
    assert.equal((await extra.call("bgmon_inspect", {})).length, 64);
    assert.match(
      (await extra.call("bgmon_start", { command: "exit 0" })).error,
      /Maximum 64 shared monitors/,
    );
    let seen: any = {};
    for (let i = 0; i < 200 && seen.captureHealth !== "complete"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      seen = await extra.call("bgmon_inspect", { id: ids[0] });
    }
    assert.equal(seen.captureHealth, "complete");
    if (seen.state === "source_unverified") {
      assert.match(
        (await extra.call("bgmon_control", { action: "forget", id: ids[0] })).error,
        /unverified/,
      );
      assert.equal(
        (await owners[0].call("bgmon_control", { action: "server_stop" })).stopped,
        true,
      );
    }
    assert.equal(
      (await extra.call("bgmon_control", { action: "forget", id: ids[0] })).forgotten,
      ids[0],
    );
    const retry = await extra.call("bgmon_start", { command: "exit 0" });
    assert.equal(retry.state, "running", JSON.stringify(retry));
    assert.equal((await extra.call("bgmon_inspect", {})).length, 64);
  } finally {
    for (const owner of owners) await owner.call("bgmon_control", { action: "server_stop" });
    for (const owner of owners) await owner.close();
    await extra.call("bgmon_control", { action: "server_stop" });
    await extra.close();
  }
});

test("empty owner backend cap releases a slot on session shutdown", async () => {
  const owners = Array.from({ length: 129 }, (_, i) => runtime(`empty-owner-${i}`));
  try {
    for (let i = 0; i < 128; i++) {
      await owners[i].start();
      assert.deepEqual(await owners[i].call("bgmon_inspect", {}), []);
    }
    await owners[128].start();
    assert.match(
      (await owners[128].call("bgmon_inspect", {})).error,
      /Maximum 128 active monitor owners/,
    );
    await owners[0].close();
    assert.deepEqual(await owners[128].call("bgmon_inspect", {}), []);
  } finally {
    for (const owner of owners) await owner.close();
  }
  const fresh = runtime("empty-owner-fresh");
  await fresh.start();
  try {
    assert.deepEqual(await fresh.call("bgmon_inspect", {}), []);
  } finally {
    await fresh.close();
  }
});

test("shared watch capacity frees slots and stopped jobs retain subscriptions", async () => {
  const owner = runtime("watch-cap-owner");
  const watchers = Array.from({ length: 9 }, (_, i) => runtime(`watch-cap-${i}`));
  await owner.start();
  try {
    const job = await owner.call("bgmon_start", { command: "sleep 30" });
    assert.ok(job.id, JSON.stringify(job));
    let firstWatch = "";
    for (let i = 0; i < 8; i++) {
      await watchers[i].start();
      for (let j = 0; j < 8; j++) {
        const watch = await watchers[i].call("bgmon_watch", {
          action: "add",
          monitorId: job.id,
          kind: "exit",
        });
        assert.ok(watch.id, JSON.stringify(watch));
        if (i === 0 && j === 0) firstWatch = watch.id;
      }
    }
    await watchers[8].start();
    assert.match(
      (await watchers[8].call("bgmon_watch", { action: "add", monitorId: job.id, kind: "exit" }))
        .error,
      /64 shared watches/,
    );
    assert.equal(
      (await watchers[0].call("bgmon_watch", { action: "remove", watchId: firstWatch })).removed,
      true,
    );
    const retry = await watchers[8].call("bgmon_watch", {
      action: "add",
      monitorId: job.id,
      kind: "exit",
    });
    assert.ok(retry.id, JSON.stringify(retry));
    assert.equal((await owner.call("bgmon_control", { action: "server_stop" })).stopped, true);
    assert.equal((await watchers[0].call("bgmon_watch", { action: "list" })).length, 7);
    assert.equal((await watchers[8].call("bgmon_watch", { action: "list" })).length, 1);
  } finally {
    await owner.call("bgmon_control", { action: "server_stop" });
    for (const watcher of watchers) await watcher.close();
    await owner.close();
  }
});

test("bgmon interface validates action arguments and command routing", async () => {
  const a = runtime("interface-validation");
  await a.start();
  try {
    assert.deepEqual(
      [...a.tools.keys()],
      ["bgmon_start", "bgmon_inspect", "bgmon_control", "bgmon_watch", "bgmon_events"],
    );
    assert.deepEqual([...a.commands.keys()], ["bgmon"]);
    assert.deepEqual(Object.keys(a.tools.get("bgmon_start").parameters.properties), [
      "command",
      "id",
    ]);
    assert.deepEqual(Object.keys(a.tools.get("bgmon_inspect").parameters.properties), [
      "id",
      "after",
      "logRef",
    ]);
    assert.deepEqual(Object.keys(a.tools.get("bgmon_control").parameters.properties), [
      "action",
      "id",
      "logRef",
    ]);
    assert.deepEqual(Object.keys(a.tools.get("bgmon_watch").parameters.properties), [
      "action",
      "monitorId",
      "watchId",
      "kind",
      "pattern",
      "flags",
      "from",
      "label",
      "delivery",
      "ttlSeconds",
      "once",
    ]);
    const job = await a.call("bgmon_start", { command: "sleep 30" });
    assert.ok(job.id, JSON.stringify(job));
    for (const p of [
      { action: "stop" },
      { action: "forget", id: "" },
      { action: "server_stop", id: " " },
    ])
      assert.match((await a.call("bgmon_control", p)).error, /non-empty identity/);
    assert.match((await a.call("bgmon_inspect", { id: "" })).error, /non-empty identity/);
    assert.match((await a.call("bgmon_inspect", { action: "list" })).error, /Unexpected argument/);
    for (const p of [
      { action: "add", kind: "exit" },
      { action: "add", monitorId: job.id },
      { action: "update", monitorId: job.id },
      { action: "remove", watchId: "" },
      { action: "list", monitorId: job.id },
      { action: "add", monitorId: job.id, kind: "exit", pattern: "x" },
    ])
      assert.ok((await a.call("bgmon_watch", p)).error, JSON.stringify(p));
    const watch = await a.call("bgmon_watch", { action: "add", monitorId: job.id, kind: "exit" });
    assert.ok(watch.id);
    assert.match(
      (await a.call("bgmon_watch", { action: "update", watchId: watch.id, kind: "changed" })).error,
      /Unexpected argument/,
    );
    assert.match(
      (await a.call("bgmon_watch", { action: "remove", watchId: job.id })).error,
      /Unknown watch/,
    );
    assert.match((await a.call("bgmon_inspect", { id: watch.id })).error, /Unknown monitor/);
    await a.command("bgmon", "stop-server unexpected");
    assert.match(a.notices.at(-1)!, /Usage/);
    assert.equal((await a.call("bgmon_inspect", { id: job.id })).state, "running");
    await a.command("bgmon", "list");
    assert.match(a.notices.at(-1)!, new RegExp(job.id));
    await a.command("bgmon", "stop-server");
    assert.match(a.notices.at(-1)!, /"stopped": true/);
  } finally {
    await a.call("bgmon_control", { action: "server_stop" });
    await a.close();
  }
});

test("session monitor limits persist and never delete existing jobs", async () => {
  const entries = [
    {
      type: "custom",
      customType: "pi-background-monitor:settings:v1",
      data: { session: "limits", limits: { maxOpen: 1, maxTotal: 2 } },
    },
  ];
  const a = runtime("limits", entries);
  await a.start();
  try {
    const first = await a.call("bgmon_start", { command: "sleep 30" });
    assert.ok(first.id, JSON.stringify(first));
    assert.match((await a.call("bgmon_start", { command: "exit 0" })).error, /Maximum 1 running/);
    await a.call("bgmon_control", { action: "stop", id: first.id });
    const second = await a.call("bgmon_start", { command: "exit 0" });
    assert.ok(second.id, JSON.stringify(second));
    assert.match((await a.call("bgmon_start", { command: "exit 0" })).error, /Maximum 2 retained/);
    await a.close();
    const b = runtime("limits", entries);
    await b.start();
    try {
      assert.equal((await b.call("bgmon_inspect", {})).length, 0);
      const fresh = await b.call("bgmon_start", { command: "sleep 30" });
      assert.equal(fresh.state, "running");
      assert.match((await b.call("bgmon_start", { command: "exit 0" })).error, /Maximum 1 running/);
    } finally {
      await b.call("bgmon_control", { action: "server_stop" });
      await b.close();
    }
  } finally {
    await a.call("bgmon_control", { action: "server_stop" });
    await a.close();
  }
});

test("dashboard displays sanitized command and watch information and completes subcommands", async () => {
  const { initTheme } = await import("@earendil-works/pi-coding-agent");
  initTheme("dark", false);
  const a = runtime("dashboard-test");
  await a.start();
  try {
    const command = a.commands.get("bgmon");
    assert.deepEqual(
      command.getArgumentCompletions("").map((x: any) => x.value),
      ["list", "settings", "stop-server"],
    );
    assert.deepEqual(
      command.getArgumentCompletions("set").map((x: any) => x.value),
      ["settings"],
    );
    assert.equal(command.getArgumentCompletions("unknown"), null);
    const job = await a.call("bgmon_start", { command: "sleep 30 # dashboard example" });
    assert.ok(job.id);
    await a.call("bgmon_watch", {
      action: "add",
      monitorId: job.id,
      kind: "exit",

      ttlSeconds: 90,
    });
    let output: string[] = [];
    let closed = false;
    a.ctx.hasUI = true;
    a.ctx.mode = "tui";
    a.ctx.ui.custom = async (factory: any, options: any) => {
      assert.equal(options.overlay, true);
      const component = factory(
        { terminal: { rows: 24 }, requestRender() {} },
        {
          fg: (_: any, text: string) => text,
          bg: (_: any, text: string) => `\x1b[44m${text}\x1b[49m`,
          bold: (text: string) => text,
        },
        { matches: (data: string, key: string) => data === key },
        () => {
          closed = true;
        },
      );
      output = component.render(80);
      assert.match(output[2], /Settings.*Monitors/);
      assert.ok(output.join("\n").includes("\x1b[44m ● Monitors \x1b[49m"));
      component.handleInput("\t");
      assert.ok(component.render(80).join("\n").includes("\x1b[44m ● Settings \x1b[49m"));
      assert.match(component.render(80).join("\n"), /Maximum running monitors/);
      component.handleInput("\t");
      assert.ok(component.render(80).join("\n").includes("\x1b[44m ● Monitors \x1b[49m"));
      assert.match(output[0], /^╭─+╮$/);
      assert.match(output.at(-1)!, /^╰─+╯$/);
      assert.ok(output.every((line: string) => visibleWidth(line) === 80));
      const narrow = component.render(30);
      assert.match(output.join("\n"), /Events 0.*queued 0.*in flight 0/);
      assert.match(narrow.join("\n"), /Events 0/);
      assert.match(narrow.at(-1), /^╰─+╯$/);
      assert.ok(narrow.every((line: string) => visibleWidth(line) === 30));
      component.handleInput("tui.select.cancel");
      assert.equal(closed, true);
    };
    await a.command("bgmon", "");
    await a.command("bgmon", "list");
    assert.match(output.join("\n"), /sleep 30 # dashboard example/);
    assert.match(output.join("\n"), /exit.*active.*hits 0/);
    assert.match(output.join("\n"), new RegExp(job.id));
  } finally {
    await a.call("bgmon_control", { action: "server_stop" });
    await a.close();
  }
});

test("settings dialog changes and saves session limits", async () => {
  const { initTheme } = await import("@earendil-works/pi-coding-agent");
  initTheme("dark", false);
  const a = runtime("settings-dialog");
  await a.start();
  try {
    a.ctx.hasUI = true;
    a.ctx.mode = "tui";
    a.ctx.ui.custom = async (factory: any, options: any) => {
      assert.equal(options.overlay, true);
      const component = factory(
        { terminal: { rows: 24 }, requestRender() {} },
        {
          fg: (_: any, value: string) => value,
          bg: (_: any, value: string) => `\x1b[44m${value}\x1b[49m`,
          bold: (value: string) => value,
        },
        { matches: (data: string, key: string) => data === key },
        () => {},
      );
      const lines = component.render(50);
      assert.ok(lines.join("\n").includes("\x1b[44m ● Settings \x1b[49m"));
      component.handleInput("\t");
      assert.ok(component.render(50).join("\n").includes("\x1b[44m ● Monitors \x1b[49m"));
      component.handleInput("\t");
      assert.match(lines[0], /^╭─+╮$/);
      assert.match(lines.at(-1), /^╰─+╯$/);
      for (const invalid of ["0", "65", "-1", "1.5"]) {
        for (const char of invalid) component.handleInput(char);
        component.handleInput("\r");
        assert.match(component.render(50).join("\n"), /whole number from 1 to 64/);
        assert.equal(
          a.entries.filter((e: any) => e.customType === "pi-background-monitor:settings:v1").length,
          0,
        );
        for (const _ of invalid) component.handleInput("\x7f");
      }
      component.handleInput("1");
      component.handleInput("\r");
      component.handleInput("\x1b[B");
      component.handleInput("6");
      component.handleInput("4");
      component.handleInput("\r");
    };
    await a.command("bgmon", "settings");
    const entries = a.entries.filter(
      (e: any) => e.customType === "pi-background-monitor:settings:v1",
    );
    assert.deepEqual(
      entries.map((e: any) => e.data.limits),
      [
        { maxOpen: 1, maxTotal: 16 },
        { maxOpen: 1, maxTotal: 64 },
      ],
    );
    const first = await a.call("bgmon_start", { command: "sleep 30" });
    assert.ok(first.id);
    assert.match((await a.call("bgmon_start", { command: "sleep 30" })).error, /Maximum 1 running/);
  } finally {
    await a.call("bgmon_control", { action: "server_stop" });
    await a.close();
  }
});

test("settings remain accessible when monitor data cannot be loaded", async () => {
  const { dashboard, DEFAULT_LIMITS } = await import("../src/ui.ts");
  const { initTheme } = await import("@earendil-works/pi-coding-agent");
  initTheme("dark", false);
  const ctx: any = {
    ui: {
      custom: async (factory: any) => {
        const component = factory(
          { terminal: { rows: 24 }, requestRender() {} },
          {
            fg: (_: string, value: string) => value,
            bg: (_: string, value: string) => `\x1b[44m${value}\x1b[49m`,
            bold: (value: string) => value,
          },
          { matches: (data: string, key: string) => data === key },
          () => {},
        );
        assert.ok(component.render(80).join("\n").includes("\x1b[44m ● Settings \x1b[49m"));
        component.handleInput("\t");
        assert.match(component.render(80).join("\n"), /monitor data unavailable/);
        assert.doesNotMatch(component.render(80).join("\n"), /No monitors yet/);
      },
    },
  };
  await dashboard(ctx, [], [], DEFAULT_LIMITS, () => {}, "settings", "monitor data unavailable");
});

for (const id of [undefined, "viewer-test"]) {
  test(`dashboard output uses the same inspection path without controlling the ${id ? "named" : "generated"} job`, async () => {
    const { initTheme } = await import("@earendil-works/pi-coding-agent");
    initTheme("dark", false);
    const a = runtime(`dashboard-output-${id ?? "generated"}`);
    await a.start();
    try {
      const job = await a.call("bgmon_start", {
        command: "echo VIEWER_SNAPSHOT_MARKER; sleep 30",
        ...(id ? { id } : {}),
      });
      assert.ok(job.id);
      if (id) assert.equal(job.id, id);
      a.ctx.hasUI = true;
      a.ctx.mode = "tui";
      a.ctx.ui.custom = async (factory: any) => {
        let closed = false;
        const component = factory(
          { terminal: { rows: 24 }, requestRender() {} },
          {
            fg: (_: string, value: string) => value,
            bg: (_: string, value: string) => value,
            bold: (value: string) => value,
          },
          { matches: (data: string, key: string) => data === key },
          () => {
            closed = true;
          },
        );
        component.handleInput("tui.select.confirm");
        const deadline = Date.now() + 5000;
        while (
          !component.render(80).join("\n").includes("VIEWER_SNAPSHOT_MARKER") &&
          Date.now() < deadline
        )
          await new Promise((resolve) => setTimeout(resolve, 50));
        const rendered = component.render(80).join("\n");
        const inspection = await a.call("bgmon_inspect", { id: job.id });
        assert.match(rendered, /VIEWER_SNAPSHOT_MARKER/);
        assert.match(inspection.untrustedOutput.text, /VIEWER_SNAPSHOT_MARKER/);
        component.handleInput("tui.select.cancel");
        assert.equal(closed, false);
        assert.match(component.render(80).join("\n"), /Selected monitor/);
        component.handleInput("tui.select.cancel");
        assert.equal(closed, true);
        component.dispose();
      };
      await a.command("bgmon", "list");
      assert.equal((await a.call("bgmon_inspect", { id: job.id })).state, "running");
    } finally {
      await a.call("bgmon_control", { action: "server_stop" });
      await a.close();
    }
  });
}

test("session shutdown closes an open output view and leaves the job detached", async () => {
  const { initTheme } = await import("@earendil-works/pi-coding-agent");
  initTheme("dark", false);
  const a = runtime("dashboard-shutdown");
  await a.start();
  let recovered: ReturnType<typeof runtime> | undefined;
  try {
    const job = await a.call("bgmon_start", { command: "sleep 30" });
    assert.ok(job.id);
    a.ctx.hasUI = true;
    a.ctx.mode = "tui";
    let component: any;
    a.ctx.ui.custom = (factory: any) =>
      new Promise<void>((resolve) => {
        component = factory(
          { terminal: { rows: 24 }, requestRender() {} },
          {
            fg: (_: string, value: string) => value,
            bg: (_: string, value: string) => value,
            bold: (value: string) => value,
          },
          { matches: (data: string, key: string) => data === key },
          () => resolve(),
        );
      });
    const command = a.command("bgmon", "list");
    const deadline = Date.now() + 5000;
    while (!component && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(component);
    component.handleInput("tui.select.confirm");
    await a.close();
    await command;
    recovered = runtime("dashboard-shutdown", a.entries);
    await recovered.start();
    assert.match((await recovered.call("bgmon_inspect", { id: job.id })).error, /Unknown monitor/);
    assert.equal((await recovered.call("bgmon_inspect", { logRef: job.logRef })).state, "unknown");
  } finally {
    if (!recovered) {
      recovered = runtime("dashboard-shutdown", a.entries);
      await recovered.start();
    }
    await recovered.call("bgmon_control", { action: "server_stop" });
    await recovered.close();
    await a.close();
  }
});

test("custom monitor IDs are shared and unique only for live indexed jobs", async () => {
  const a = runtime("named-owner"),
    b = runtime("named-other");
  await a.start();
  await b.start();
  try {
    for (const id of ["", "  ", "../evil", "bad\nname", "a".repeat(65)])
      assert.match(
        (await a.call("bgmon_start", { command: "exit 0", id })).error,
        /Invalid job ID/,
      );
    const named = await a.call("bgmon_start", { command: "sleep 30", id: "build-api_1" });
    assert.equal(named.id, "build-api_1", JSON.stringify(named));
    assert.match(
      (await a.call("bgmon_start", { command: "sleep 30", id: "BUILD-API_1" })).error,
      /case-insensitive/,
    );
    const generated = await a.call("bgmon_start", { command: "sleep 30" });
    assert.match(generated.id, /^[a-f0-9]{24}$/);
    assert.match(
      (await a.call("bgmon_start", { command: "exit 0", id: generated.id })).error,
      /reserved generated ID/,
    );
    assert.match(
      (await b.call("bgmon_start", { command: "sleep 30", id: named.id })).error,
      /Duplicate monitor identity/,
    );
    assert.equal((await b.call("bgmon_inspect", { id: named.id })).state, "running");
    const watch = await b.call("bgmon_watch", { action: "add", monitorId: named.id, kind: "exit" });
    assert.ok(watch.id);
    await a.close();
    await b.close();
    const reopened = runtime("named-owner", a.entries);
    await reopened.start();
    try {
      assert.match(
        (await reopened.call("bgmon_inspect", { id: named.id })).error,
        /Unknown monitor/,
      );
      assert.deepEqual(await reopened.call("bgmon_inspect", {}), []);
      assert.equal(
        (await reopened.call("bgmon_inspect", { logRef: named.logRef })).state,
        "unknown",
      );
    } finally {
      await reopened.call("bgmon_control", { action: "server_stop" });
      await reopened.close();
    }
  } finally {
    const cleanup = runtime("named-owner", a.entries);
    await a.close();
    await b.close();
    await cleanup.start();
    await cleanup.call("bgmon_control", { action: "server_stop" });
    await cleanup.close();
  }
});

test("historical references do not follow reused readable IDs", async () => {
  const a = runtime("collision-first"),
    b = runtime("collision-second");
  await a.start();
  const first = await a.call("bgmon_start", { command: "sleep 30", id: "deploy" });
  assert.equal(first.id, "deploy");
  await a.close();
  await b.start();
  const resumed = runtime("collision-first", a.entries);
  try {
    const second = await b.call("bgmon_start", { command: "sleep 30", id: "deploy" });
    assert.equal(second.id, "deploy");
    await resumed.start();
    assert.deepEqual(await resumed.call("bgmon_watch", { action: "list" }), []);
    assert.equal(
      (await resumed.call("bgmon_inspect", { id: "deploy" })).logRef.stream,
      second.logRef.stream,
    );
    const historical = await resumed.call("bgmon_inspect", { logRef: first.logRef });
    assert.equal(historical.state, "unknown");
    assert.equal(historical.logRef.stream, first.logRef.stream);
  } finally {
    await b.call("bgmon_control", { action: "server_stop" });
    await b.close();
    await resumed.close();
  }
});

test("regex watches validate inputs and notify on matching journal lines", async () => {
  const a = runtime("regex-watch");
  await a.start();
  try {
    const job = await a.call("bgmon_start", {
      command: "sleep 1; echo 'error TS1234: secret'; sleep 8",
    });
    assert.ok(job.id, JSON.stringify(job));
    for (const args of [
      { kind: "regex", pattern: "(" },
      { kind: "regex", pattern: "a", flags: "g" },
      { kind: "regex", pattern: "a", flags: "ii" },
      { kind: "contains", pattern: "a", flags: "i" },
      { kind: "regex", pattern: "" },
    ]) {
      const result = await a.call("bgmon_watch", { action: "add", monitorId: job.id, ...args });
      assert.ok(result.error, JSON.stringify(result));
    }
    const watch = await a.call("bgmon_watch", {
      action: "add",
      monitorId: job.id,
      kind: "regex",
      pattern: "ERROR TS\\d+",
      flags: "i",
      delivery: "wake",
    });
    assert.ok(watch.id, JSON.stringify(watch));
    const deadline = Date.now() + 6000;
    while (!a.messages.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.equal(a.messages.length, 1);
    assert.match(a.messages[0][0].content, /regex/);
    assert.doesNotMatch(a.messages[0][0].content, /TS1234|secret|ERROR/);
    assert.deepEqual(a.messages[0][1], { deliverAs: "followUp", triggerTurn: true });
  } finally {
    await a.call("bgmon_control", { action: "server_stop" });
    await a.close();
  }
});

test("slow regex watch fails with metadata-only notice and literal watches still work", async () => {
  const a = runtime("regex-timeout");
  await a.start();
  try {
    const job = await a.call("bgmon_start", {
      command: "sleep 1; printf '%1000s' '' | tr ' ' a; echo '!'; sleep 8",
    });
    assert.ok(job.id, JSON.stringify(job));
    const regex = await a.call("bgmon_watch", {
      action: "add",
      monitorId: job.id,
      kind: "regex",
      pattern: "(a+)+b",
      delivery: "wake",
    });
    const literal = await a.call("bgmon_watch", {
      action: "add",
      monitorId: job.id,
      kind: "contains",
      pattern: "(a+)+b",
    });
    assert.ok(regex.id && literal.id);
    const deadline = Date.now() + 7000;
    while (!a.messages.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.equal(a.messages.length, 1);
    assert.match(a.messages[0][0].content, /regex_evaluation_failed/);
    assert.doesNotMatch(a.messages[0][0].content, /\(a\+\)\+b|aaaa/);
    const watches = await a.call("bgmon_watch", { action: "list" });
    assert.equal(watches.find((w: { id: string }) => w.id === regex.id).state, "failed");
    assert.equal(watches.find((w: { id: string }) => w.id === literal.id).state, "active");
  } finally {
    await a.call("bgmon_control", { action: "server_stop" });
    await a.close();
  }
});

test("completed historical logs can be deleted without reviving a monitor", async () => {
  const owner = runtime("history-delete");
  await owner.start();
  const job = await owner.call("bgmon_start", { command: "echo done" });
  try {
    let seen: any = {};
    for (let i = 0; i < 200 && seen.captureHealth !== "complete"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      seen = await owner.call("bgmon_inspect", { id: job.id });
    }
    assert.equal(seen.captureHealth, "complete");
    assert.match(
      (await owner.call("bgmon_control", { action: "delete_history", logRef: job.logRef })).error,
      /Use forget/,
    );
    if (seen.state === "source_unverified") {
      assert.equal((await owner.call("bgmon_control", { action: "server_stop" })).stopped, true);
    }
    await owner.close();
    const other = runtime("other-session");
    await other.start();
    try {
      assert.ok(
        (await other.call("bgmon_control", { action: "delete_history", logRef: job.logRef })).error,
      );
    } finally {
      await other.close();
    }
    const resumed = runtime("history-delete", owner.entries);
    await resumed.start();
    try {
      assert.deepEqual(await resumed.call("bgmon_inspect", {}), []);
      assert.equal(
        (await resumed.call("bgmon_control", { action: "delete_history", logRef: job.logRef }))
          .deleted,
        true,
      );
      assert.ok((await resumed.call("bgmon_inspect", { logRef: job.logRef })).error);
    } finally {
      await resumed.close();
    }
  } finally {
    await owner.close();
  }
});

test("a closed capture pipe does not authorize deleting a still-running producer", async () => {
  const owner = runtime("history-live-producer");
  await owner.start();
  const job = await owner.call("bgmon_start", { command: "exec sleep 30" });
  try {
    const panes = await checked(["-S", job.socket, "list-panes", "-a", "-F", "#{pane_id}"]);
    await checked(["-S", job.socket, "pipe-pane", "-t", panes.stdout.trim().split("\n")[0]]);
    await owner.close();
    const resumed = runtime("history-live-producer", owner.entries);
    await resumed.start();
    try {
      let seen: any = {};
      for (let i = 0; i < 200 && seen.captureHealth !== "complete"; i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        seen = await resumed.call("bgmon_inspect", { logRef: job.logRef });
      }
      assert.equal(seen.captureHealth, "complete");
      assert.equal(seen.state, "unknown");
      assert.match(
        (await resumed.call("bgmon_control", { action: "delete_history", logRef: job.logRef }))
          .error,
        /Producer stop is unverified/,
      );
    } finally {
      await resumed.close();
    }
  } finally {
    await owner.close();
  }
});

test("explicit historical deletion reclaims a verified dead detached pane", async () => {
  const owner = runtime("history-dead-pane");
  await owner.start();
  const job = await owner.call("bgmon_start", { command: "sleep 0.5; exit 7" });
  try {
    await owner.close();
    await new Promise((resolve) => setTimeout(resolve, 800));
    const resumed = runtime("history-dead-pane", owner.entries);
    await resumed.start();
    const { boundedIo, Tmux } = await import("../src/tmux.ts");
    const original = Tmux.prototype.sourceOperation;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reservations: Promise<unknown>[] = [];
    Tmux.prototype.sourceOperation = async function (...args) {
      await original.apply(this, args);
      if (args[3] === "exited" && args[4] === "kill")
        reservations = Array.from({ length: 16 }, () =>
          boundedIo(() => gate, 20).catch(() => undefined),
        );
    };
    try {
      assert.deepEqual(await resumed.call("bgmon_inspect", {}), []);
      assert.equal((await resumed.call("bgmon_inspect", { logRef: job.logRef })).state, "unknown");
      assert.ok(
        (await resumed.call("bgmon_control", { action: "delete_history", logRef: job.logRef }))
          .error,
      );
      release();
      await Promise.all(reservations);
      await new Promise((resolve) => setImmediate(resolve));
      const deletion = await resumed.call("bgmon_control", {
        action: "delete_history",
        logRef: job.logRef,
      });
      if (reservations.length === 0) {
        assert.match(deletion.error, /Producer stop is unverified/);
        assert.equal(
          (await resumed.call("bgmon_inspect", { logRef: job.logRef })).state,
          "unknown",
        );
      } else assert.equal(deletion.deleted, true);
    } finally {
      release();
      Tmux.prototype.sourceOperation = original;
      await Promise.all(reservations);
      await resumed.close();
    }
  } finally {
    await owner.close();
  }
});

test("journal watches catch transient errors beyond the old snapshot window", async () => {
  const a = runtime("journal-filter");
  await a.start();
  try {
    const job = await a.call("bgmon_start", {
      command:
        "sleep 0.8; echo ERROR_ONCE; for ((i=0;i<2000;i++)); do printf 'routine-output-%04d-xxxxxxxxxxxxxxxx\\n' $i; done; sleep 5",
    });
    assert.equal(job.state, "running");
    const watch = await a.call("bgmon_watch", {
      action: "add",
      monitorId: job.id,
      kind: "contains",
      pattern: "ERROR_ONCE",
      delivery: "wake",
    });
    assert.ok(watch.id, JSON.stringify(watch));
    for (let i = 0; i < 300 && !a.messages.length; i++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(a.messages.length, 1);
    assert.doesNotMatch(a.messages[0][0].content, /ERROR_ONCE/);
    const state = (await a.call("bgmon_watch", { action: "list" })).find(
      (w: any) => w.id === watch.id,
    );
    assert.equal(state.state, "fired");
    assert.equal(state.hits, 1);
  } finally {
    await a.call("bgmon_control", { action: "server_stop" });
    await a.close();
  }
});

test("retained regex watches match final unterminated lines and repeated lines count separately", async () => {
  const a = runtime("journal-retained");
  await a.start();
  try {
    const job = await a.call("bgmon_start", {
      command: "printf 'repeat\\nrepeat\\nrepeat\\ntail-ERROR'",
    });
    let seen: any = {};
    for (let i = 0; i < 200 && seen.captureHealth !== "complete"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      seen = await a.call("bgmon_inspect", { id: job.id });
    }
    assert.equal(seen.captureHealth, "complete");
    const repeat = await a.call("bgmon_watch", {
      action: "add",
      monitorId: job.id,
      kind: "contains",
      pattern: "repeat",
      from: "retained",
      once: false,
    });
    const tail = await a.call("bgmon_watch", {
      action: "add",
      monitorId: job.id,
      kind: "regex",
      pattern: "tail-error$",
      flags: "i",
      from: "retained",
    });
    for (let i = 0; i < 300; i++) {
      const list = await a.call("bgmon_watch", { action: "list" });
      if (
        list.find((w: any) => w.id === repeat.id)?.state !== "active" &&
        list.find((w: any) => w.id === tail.id)?.state !== "active"
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const list = await a.call("bgmon_watch", { action: "list" });
    assert.equal(list.find((w: any) => w.id === repeat.id).hits, 3);
    assert.equal(list.find((w: any) => w.id === tail.id).state, "fired");
    assert.equal(list.find((w: any) => w.id === tail.id).hits, 1);
  } finally {
    await a.call("bgmon_control", { action: "server_stop" });
    await a.close();
  }
});

test("from-now watches skip an existing partial line and report expiry", async () => {
  const a = runtime("journal-partial");
  await a.start();
  try {
    const job = await a.call("bgmon_start", {
      command: "printf 'old-prefix'; sleep 1; printf 'OLD_SUFFIX\\nNEW_LINE\\n'; sleep 3",
    });
    for (let i = 0; i < 100; i++) {
      if (
        (await a.call("bgmon_inspect", { id: job.id })).untrustedOutput?.text.includes("old-prefix")
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const old = await a.call("bgmon_watch", {
      action: "add",
      monitorId: job.id,
      kind: "contains",
      pattern: "OLD_SUFFIX",
      ttlSeconds: 2,
    });
    const fresh = await a.call("bgmon_watch", {
      action: "add",
      monitorId: job.id,
      kind: "contains",
      pattern: "NEW_LINE",
    });
    for (let i = 0; i < 250; i++) {
      const list = await a.call("bgmon_watch", { action: "list" });
      if (
        list.find((w: any) => w.id === old.id)?.state === "expired" &&
        list.find((w: any) => w.id === fresh.id)?.state === "fired"
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const list = await a.call("bgmon_watch", { action: "list" });
    assert.equal(list.find((w: any) => w.id === old.id).state, "expired");
    assert.equal(list.find((w: any) => w.id === old.id).hits, 0);
    assert.equal(list.find((w: any) => w.id === fresh.id).hits, 1);
  } finally {
    await a.call("bgmon_control", { action: "server_stop" });
    await a.close();
  }
});

test("overlong logical lines fail watches visibly", async () => {
  const a = runtime("journal-long-line");
  await a.start();
  try {
    const job = await a.call("bgmon_start", {
      command: "sleep 0.5; printf '%70000s' ''; echo; sleep 3",
    });
    const watch = await a.call("bgmon_watch", { action: "add", monitorId: job.id, kind: "any" });
    for (let i = 0; i < 250; i++) {
      const state = (await a.call("bgmon_watch", { action: "list" })).find(
        (w: any) => w.id === watch.id,
      );
      if (state?.state === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const state = (await a.call("bgmon_watch", { action: "list" })).find(
      (w: any) => w.id === watch.id,
    );
    assert.equal(state.state, "failed");
    assert.equal(state.error, "line_too_long");
  } finally {
    await a.call("bgmon_control", { action: "server_stop" });
    await a.close();
  }
});

test("failed captures drain all published pages before failing a watch", async () => {
  const a = runtime("failed-tail-pages");
  await a.start();
  try {
    const job = await a.call("bgmon_start", { command: "echo seed" });
    let seen: any = {};
    for (let i = 0; i < 200 && seen.captureHealth !== "complete"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      seen = await a.call("bgmon_inspect", { id: job.id });
    }
    assert.equal(seen.captureHealth, "complete");
    const { readdir, writeFile } = await import("node:fs/promises");
    const dir = join(
      process.env.XDG_STATE_HOME!,
      "pi-background-monitor",
      "owners",
      job.logRef.owner,
      job.logRef.stream,
    );
    for (const name of await readdir(dir)) if (name.endsWith(".jsonl")) await rm(join(dir, name));
    let start = 0;
    const frames = Array.from({ length: 201 }, (_, index) => {
      const data = Buffer.from(index === 200 ? "PUBLISHED_MATCH\n" : "noise\n");
      const frame = {
        version: 1,
        stream: job.logRef.stream,
        sequence: index + 1,
        start,
        end: start + data.length,
        kind: "output",
        data: data.toString("base64"),
      };
      start += data.length;
      return JSON.stringify(frame);
    });
    await writeFile(join(dir, "1.jsonl"), `${frames.join("\n")}\n`, { mode: 0o600 });
    await writeFile(
      join(dir, "capture.json"),
      JSON.stringify({
        version: 1,
        stream: job.logRef.stream,
        first: 1,
        tail: 201,
        health: "failed",
      }),
      { mode: 0o600 },
    );
    const watch = await a.call("bgmon_watch", {
      action: "add",
      monitorId: job.id,
      kind: "contains",
      pattern: "PUBLISHED_MATCH",
      from: "retained",
    });
    for (let i = 0; i < 200; i++) {
      const state = (await a.call("bgmon_watch", { action: "list" })).find(
        (w: any) => w.id === watch.id,
      );
      if (state?.state !== "active") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const state = (await a.call("bgmon_watch", { action: "list" })).find(
      (w: any) => w.id === watch.id,
    );
    assert.equal(state.state, "failed");
    assert.equal(state.error, "capture_incomplete");
    assert.equal(state.hits, 1);
  } finally {
    await a.call("bgmon_control", { action: "server_stop" });
    await a.close();
  }
});

test("expiry drains a committed final unterminated line before expiring", async () => {
  const a = runtime("expiry-final-line");
  await a.start();
  try {
    const job = await a.call("bgmon_start", {
      command: "for ((i=0;i<1000;i++)); do echo noise; done; printf FINAL_MATCH",
    });
    let seen: any = {};
    for (let i = 0; i < 200 && seen.captureHealth !== "complete"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      seen = await a.call("bgmon_inspect", { id: job.id });
    }
    assert.equal(seen.captureHealth, "complete");
    const watch = await a.call("bgmon_watch", {
      action: "add",
      monitorId: job.id,
      kind: "contains",
      pattern: "FINAL_MATCH",
      from: "retained",
      ttlSeconds: 1,
    });
    for (let i = 0; i < 250; i++) {
      const state = (await a.call("bgmon_watch", { action: "list" })).find(
        (w: any) => w.id === watch.id,
      );
      if (state?.state !== "active") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const state = (await a.call("bgmon_watch", { action: "list" })).find(
      (w: any) => w.id === watch.id,
    );
    assert.equal(state.state, "fired");
    assert.equal(state.hits, 1);
  } finally {
    await a.call("bgmon_control", { action: "server_stop" });
    await a.close();
  }
});

test("lost sources drain newly committed lines before reporting failure", async () => {
  const { Manager } = await import("../src/manager.ts");
  const a = runtime("lost-drain");
  await a.start();
  const original = Manager.prototype.watchRead;
  try {
    const job = await a.call("bgmon_start", { command: "sleep 0.8; echo BUFFERED_MATCH; sleep 3" });
    const watch = await a.call("bgmon_watch", {
      action: "add",
      monitorId: job.id,
      kind: "contains",
      pattern: "BUFFERED_MATCH",
    });
    Manager.prototype.watchRead = async function (id, stream, after) {
      const page = await original.call(this, id, stream, after);
      return id === job.id
        ? { ...page, health: "ready", status: { state: "lost", capture: "unknown" } }
        : page;
    };
    for (let i = 0; i < 200; i++) {
      const state = (await a.call("bgmon_watch", { action: "list" })).find(
        (w: any) => w.id === watch.id,
      );
      if (state?.state !== "active") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const state = (await a.call("bgmon_watch", { action: "list" })).find(
      (w: any) => w.id === watch.id,
    );
    assert.equal(state.state, "failed");
    assert.equal(state.error, "capture_incomplete");
    assert.equal(state.hits, 1);
  } finally {
    Manager.prototype.watchRead = original;
    await a.call("bgmon_control", { action: "server_stop" });
    await a.close();
  }
});

test("an expiry boundary preserves known capture failure", async () => {
  const { Manager } = await import("../src/manager.ts");
  const a = runtime("expiry-integrity");
  await a.start();
  const original = Manager.prototype.watchRead;
  try {
    const job = await a.call("bgmon_start", { command: "sleep 5" });
    const watch = await a.call("bgmon_watch", {
      action: "add",
      monitorId: job.id,
      kind: "contains",
      pattern: "NEVER",
      ttlSeconds: 1,
    });
    let first = true;
    Manager.prototype.watchRead = async function (id, stream, after) {
      if (id === job.id && first) {
        first = false;
        await new Promise((resolve) => setTimeout(resolve, 1100));
      }
      const page = await original.call(this, id, stream, after);
      return id === job.id ? { ...page, health: "failed" } : page;
    };
    for (let i = 0; i < 200; i++) {
      const state = (await a.call("bgmon_watch", { action: "list" })).find(
        (w: any) => w.id === watch.id,
      );
      if (state?.state !== "active") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const state = (await a.call("bgmon_watch", { action: "list" })).find(
      (w: any) => w.id === watch.id,
    );
    assert.equal(state.state, "failed");
    assert.equal(state.error, "capture_incomplete");
    assert.equal(state.expired, true);
  } finally {
    Manager.prototype.watchRead = original;
    await a.call("bgmon_control", { action: "server_stop" });
    await a.close();
  }
});

test("a stalled watch read does not starve another live session", async () => {
  const { Manager } = await import("../src/manager.ts");
  const a = runtime("read-stall-owner"),
    b = runtime("read-stall-sibling");
  await a.start();
  await b.start();
  const original = Manager.prototype.watchRead;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const reading = new Promise<void>((resolve) => {
    entered = resolve;
  });
  try {
    const slowJob = await a.call("bgmon_start", { command: "sleep 10" });
    const fastJob = await b.call("bgmon_start", { command: "sleep 0.8; echo FAST_READY; sleep 3" });
    await a.call("bgmon_watch", { action: "add", monitorId: slowJob.id, kind: "any" });
    const fast = await b.call("bgmon_watch", {
      action: "add",
      monitorId: fastJob.id,
      kind: "contains",
      pattern: "FAST_READY",
    });
    Manager.prototype.watchRead = async function (id, stream, after) {
      if (id === slowJob.id) {
        entered();
        await gate;
      }
      return original.call(this, id, stream, after);
    };
    await waitForBackground(reading);
    const start = Date.now();
    const control = await Promise.race([
      a.call("bgmon_control", { action: "forget", id: slowJob.id }),
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 3500)),
    ]);
    assert.ok(control, "owner control must not wait for the stalled read");
    assert.match(control.error, /running/);
    let state: any = {};
    while (Date.now() - start < 4000 && state.state !== "fired") {
      await new Promise((resolve) => setTimeout(resolve, 50));
      state =
        (await b.call("bgmon_watch", { action: "list" })).find((w: any) => w.id === fast.id) ?? {};
    }
    assert.equal(state.state, "fired");
    assert.ok(Date.now() - start < 4000);
  } finally {
    Manager.prototype.watchRead = original;
    release();
    await a.call("bgmon_control", { action: "server_stop" });
    await b.call("bgmon_control", { action: "server_stop" });
    await a.close();
    await b.close();
  }
});

test("expiry samples a fresh tail rather than reusing a stalled pre-deadline read", async () => {
  const { Manager } = await import("../src/manager.ts");
  const a = runtime("expiry-fresh-boundary");
  await a.start();
  const original = Manager.prototype.watchRead;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    const job = await a.call("bgmon_start", {
      command: "sleep 0.6; echo BEFORE_DEADLINE; sleep 4",
    });
    const watch = await a.call("bgmon_watch", {
      action: "add",
      monitorId: job.id,
      kind: "contains",
      pattern: "BEFORE_DEADLINE",
      ttlSeconds: 1,
    });
    let first = true;
    Manager.prototype.watchRead = async function (id, stream, after) {
      const page = await original.call(this, id, stream, after);
      if (id === job.id && first) {
        first = false;
        await gate;
      }
      return page;
    };
    setTimeout(release, 1600).unref();
    let state: any = {};
    for (let i = 0; i < 300 && state.state !== "fired"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      state =
        (await a.call("bgmon_watch", { action: "list" })).find((w: any) => w.id === watch.id) ?? {};
      if (state.state === "expired" || state.state === "failed") break;
    }
    assert.equal(state.state, "fired");
    assert.equal(state.hits, 1);
  } finally {
    Manager.prototype.watchRead = original;
    release();
    await a.call("bgmon_control", { action: "server_stop" });
    await a.close();
  }
});

test("clean EOF flushes the final line even when producer status is lost", async () => {
  const { Manager } = await import("../src/manager.ts");
  const a = runtime("lost-clean-eof");
  await a.start();
  const original = Manager.prototype.watchRead;
  try {
    const job = await a.call("bgmon_start", { command: "printf LOST_FINAL_MATCH" });
    let seen: any = {};
    for (let i = 0; i < 200 && seen.captureHealth !== "complete"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      seen = await a.call("bgmon_inspect", { id: job.id });
    }
    assert.equal(seen.captureHealth, "complete");
    const watch = await a.call("bgmon_watch", {
      action: "add",
      monitorId: job.id,
      kind: "contains",
      pattern: "LOST_FINAL_MATCH",
      from: "retained",
    });
    Manager.prototype.watchRead = async function (id, stream, after) {
      const page = await original.call(this, id, stream, after);
      return id === job.id ? { ...page, status: { state: "lost", capture: "unknown" } } : page;
    };
    let state: any = {};
    for (let i = 0; i < 200 && state.state !== "failed"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      state =
        (await a.call("bgmon_watch", { action: "list" })).find((w: any) => w.id === watch.id) ?? {};
    }
    assert.equal(state.hits, 1);
    assert.equal(state.state, "failed");
    assert.equal(state.error, "capture_incomplete");
  } finally {
    Manager.prototype.watchRead = original;
    await a.call("bgmon_control", { action: "server_stop" });
    await a.close();
  }
});

test("late successful watch reads are consumed instead of perpetually retried", async () => {
  const { Manager } = await import("../src/manager.ts");
  const a = runtime("late-watch-read");
  await a.start();
  const original = Manager.prototype.watchRead;
  try {
    const job = await a.call("bgmon_start", { command: "sleep 0.5; echo LATE_MATCH; sleep 5" });
    const watch = await a.call("bgmon_watch", {
      action: "add",
      monitorId: job.id,
      kind: "contains",
      pattern: "LATE_MATCH",
    });
    Manager.prototype.watchRead = async function (id, stream, after) {
      const page = await original.call(this, id, stream, after);
      if (id === job.id) await new Promise((resolve) => setTimeout(resolve, 1200));
      return page;
    };
    let state: any = {};
    for (let i = 0; i < 350 && state.state !== "fired"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      state =
        (await a.call("bgmon_watch", { action: "list" })).find((w: any) => w.id === watch.id) ?? {};
    }
    assert.equal(state.state, "fired");
    assert.equal(state.hits, 1);
  } finally {
    Manager.prototype.watchRead = original;
    await a.call("bgmon_control", { action: "server_stop" });
    await a.close();
  }
});

test("stalled removed watches obey per-owner and global IO bounds", async () => {
  const { Manager } = await import("../src/manager.ts");
  const { broker } = await import("../src/broker.ts");
  const owners = Array.from({ length: 4 }, (_, i) => runtime(`watch-io-cap-${i}`));
  const healthy = runtime("watch-io-cap-healthy");
  const original = Manager.prototype.watchRead;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const slowIds = new Set<string>();
  let calls = 0;
  try {
    for (const owner of owners) {
      await owner.start();
      const job = await owner.call("bgmon_start", { command: "sleep 15" });
      slowIds.add(job.id);
    }
    Manager.prototype.watchRead = async function (id, stream, after) {
      if (slowIds.has(id)) {
        calls++;
        await gate;
      }
      return original.call(this, id, stream, after);
    };
    for (let i = 0; i < owners.length; i++) {
      const owner = owners[i],
        id = [...slowIds][i];
      for (let j = 0; j < (i === 0 ? 5 : 4); j++) {
        const watch = await owner.call("bgmon_watch", {
          action: "add",
          monitorId: id,
          kind: "any",
        });
        if (i === 0 && j === 4) {
          assert.match(watch.error, /capacity exhausted/);
          continue;
        }
        assert.ok(watch.id);
        await (broker as any).current.tick();
        await Promise.resolve();
        assert.equal(
          (await owner.call("bgmon_watch", { action: "remove", watchId: watch.id })).removed,
          true,
        );
      }
      if (i === 0) assert.equal(calls, 4);
      if (i === 1) {
        await healthy.start();
        const job = await healthy.call("bgmon_start", {
          command: "sleep 0.4; echo FAST_AFTER_STALL; sleep 4",
        });
        const watch = await healthy.call("bgmon_watch", {
          action: "add",
          monitorId: job.id,
          kind: "contains",
          pattern: "FAST_AFTER_STALL",
        });
        let state: any = {};
        const deadline = Date.now() + 2500;
        while (Date.now() < deadline && state.state !== "fired") {
          await new Promise((resolve) => setTimeout(resolve, 20));
          state =
            (await healthy.call("bgmon_watch", { action: "list" })).find(
              (w: any) => w.id === watch.id,
            ) ?? {};
        }
        assert.equal(state.state, "fired");
      }
    }
    assert.equal(calls, 16);
    assert.equal((broker as any).physical.ioInFlight, 16);
  } finally {
    Manager.prototype.watchRead = original;
    release();
    for (let i = 0; i < 100 && (broker as any).physical.ioInFlight; i++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    for (const owner of owners) await owner.call("bgmon_control", { action: "server_stop" });
    for (const owner of owners) await owner.close();
    await healthy.call("bgmon_control", { action: "server_stop" });
    await healthy.close();
  }
});

test("renewing TTL cannot reuse a stale in-flight expiry boundary", async () => {
  const { Manager } = await import("../src/manager.ts");
  const a = runtime("renew-boundary");
  await a.start();
  const originalRead = Manager.prototype.watchRead,
    originalBoundary = Manager.prototype.watchBoundary;
  let release!: () => void, boundaryStarted!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    boundaryStarted = resolve;
  });
  try {
    const job = await a.call("bgmon_start", { command: "sleep 1.6; echo RENEW_MATCH; sleep 4" });
    const watch = await a.call("bgmon_watch", {
      action: "add",
      monitorId: job.id,
      kind: "contains",
      pattern: "RENEW_MATCH",
      ttlSeconds: 1,
    });
    let firstRead = true,
      firstBoundary = true;
    Manager.prototype.watchRead = async function (id, stream, after) {
      const page = await originalRead.call(this, id, stream, after);
      if (id === job.id && firstRead) {
        firstRead = false;
        await gate;
      }
      return page;
    };
    Manager.prototype.watchBoundary = async function (id, stream) {
      const snapshot = await originalBoundary.call(this, id, stream);
      if (id === job.id && firstBoundary) {
        firstBoundary = false;
        boundaryStarted();
        await gate;
      }
      return snapshot;
    };
    await waitForBackground(entered);
    assert.equal(
      (await a.call("bgmon_watch", { action: "update", watchId: watch.id, ttlSeconds: 1 })).state,
      "active",
    );
    await new Promise((resolve) => setTimeout(resolve, 1200));
    release();
    let state: any = {};
    for (let i = 0; i < 250; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      state =
        (await a.call("bgmon_watch", { action: "list" })).find((w: any) => w.id === watch.id) ?? {};
      if (state.state && state.state !== "active") break;
    }
    if (state.state === "fired") assert.equal(state.hits, 1);
    else {
      assert.equal(state.state, "failed");
      assert.equal(state.error, "expiry_boundary_unavailable");
      assert.equal(state.hits, 0);
    }
  } finally {
    Manager.prototype.watchRead = originalRead;
    Manager.prototype.watchBoundary = originalBoundary;
    release();
    await a.call("bgmon_control", { action: "server_stop" });
    await a.close();
  }
});

test("an exit observed after the expiry deadline does not trigger an exit watch", async () => {
  const { Manager } = await import("../src/manager.ts");
  const a = runtime("exit-deadline");
  await a.start();
  const original = Manager.prototype.watchStatus;
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reading = new Promise<void>((resolve) => {
    entered = resolve;
  });
  try {
    const job = await a.call("bgmon_start", { command: "sleep 1.2; exit 0" });
    const watch = await a.call("bgmon_watch", {
      action: "add",
      monitorId: job.id,
      kind: "exit",
      ttlSeconds: 1,
    });
    Manager.prototype.watchStatus = async function (id, stream) {
      const page = await original.call(this, id, stream);
      if (id === job.id) {
        entered();
        await gate;
      }
      return page;
    };
    await waitForBackground(reading);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    release();
    let state: any = {};
    for (let i = 0; i < 100 && state.state !== "expired"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      state =
        (await a.call("bgmon_watch", { action: "list" })).find((w: any) => w.id === watch.id) ?? {};
    }
    assert.equal(state.state, "expired");
    assert.equal(state.hits, 0);
  } finally {
    Manager.prototype.watchStatus = original;
    release();
    await a.call("bgmon_control", { action: "server_stop" });
    await a.close();
  }
});

test("a journal gap fails closed instead of matching uncertain OSC payload", async () => {
  const { readdir, writeFile } = await import("node:fs/promises");
  const a = runtime("gap-osc");
  await a.start();
  try {
    const job = await a.call("bgmon_start", { command: "echo seed" });
    let seen: any = {};
    for (let i = 0; i < 200 && seen.captureHealth !== "complete"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      seen = await a.call("bgmon_inspect", { id: job.id });
    }
    assert.equal(seen.captureHealth, "complete");
    const dir = join(
      process.env.XDG_STATE_HOME!,
      "pi-background-monitor",
      "owners",
      job.logRef.owner,
      job.logRef.stream,
    );
    for (const name of await readdir(dir)) if (name.endsWith(".jsonl")) await rm(join(dir, name));
    const encode = (sequence: number, start: number, text: string) => {
      const data = Buffer.from(text);
      return JSON.stringify({
        version: 1,
        stream: job.logRef.stream,
        sequence,
        start,
        end: start + data.length,
        kind: "output",
        data: data.toString("base64"),
      });
    };
    await writeFile(
      join(dir, "1.jsonl"),
      `${encode(1, 0, "safe\n")}\n${encode(3, 20, "\nFALSE_MATCH\n")}\n`,
      { mode: 0o600 },
    );
    await writeFile(
      join(dir, "capture.json"),
      JSON.stringify({
        version: 1,
        stream: job.logRef.stream,
        first: 1,
        tail: 3,
        health: "complete",
      }),
      { mode: 0o600 },
    );
    const watch = await a.call("bgmon_watch", {
      action: "add",
      monitorId: job.id,
      kind: "contains",
      pattern: "FALSE_MATCH",
      from: "retained",
    });
    let state: any = {};
    for (let i = 0; i < 200 && state.state !== "failed"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      state =
        (await a.call("bgmon_watch", { action: "list" })).find((w: any) => w.id === watch.id) ?? {};
    }
    assert.equal(state.state, "failed");
    assert.equal(state.error, "parser_uncertain_after_gap");
    assert.equal(state.hits, 0);
  } finally {
    await a.call("bgmon_control", { action: "server_stop" });
    await a.close();
  }
});

test("new watches remain usable after normal journal rotation", async () => {
  const { TextNormalizer } = await import("../src/text.mjs");
  const { readdir, writeFile } = await import("node:fs/promises");
  const a = runtime("rotated-checkpoint");
  await a.start();
  try {
    const job = await a.call("bgmon_start", { command: "echo seed" });
    let seen: any = {};
    for (let i = 0; i < 200 && seen.captureHealth !== "complete"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      seen = await a.call("bgmon_inspect", { id: job.id });
    }
    assert.equal(seen.captureHealth, "complete");
    for (let i = 0; i < 250 && seen.capture !== "complete"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      seen = await a.call("bgmon_inspect", { id: job.id });
    }
    assert.equal(seen.capture, "complete");
    const dir = join(
      process.env.XDG_STATE_HOME!,
      "pi-background-monitor",
      "owners",
      job.logRef.owner,
      job.logRef.stream,
    );
    for (const name of await readdir(dir)) if (name.endsWith(".jsonl")) await rm(join(dir, name));
    const normalizer = new TextNormalizer();
    normalizer.write(Buffer.from("old-partial"));
    const firstText = normalizer.snapshot();
    const data = Buffer.from("-tail\nRETAIN_MATCH\n");
    normalizer.write(data);
    const tailText = normalizer.snapshot();
    const frame = {
      version: 1,
      stream: job.logRef.stream,
      sequence: 2,
      start: 11,
      end: 11 + data.length,
      kind: "output",
      data: data.toString("base64"),
    };
    await writeFile(join(dir, "2.jsonl"), `${JSON.stringify(frame)}\n`, { mode: 0o600 });
    await writeFile(
      join(dir, "capture.json"),
      JSON.stringify({
        version: 1,
        stream: job.logRef.stream,
        first: 2,
        tail: 2,
        health: "complete",
        firstText,
        tailText,
      }),
      { mode: 0o600 },
    );
    const retained = await a.call("bgmon_watch", {
      action: "add",
      monitorId: job.id,
      kind: "contains",
      pattern: "RETAIN_MATCH",
      from: "retained",
    });
    const now = await a.call("bgmon_watch", {
      action: "add",
      monitorId: job.id,
      kind: "any",
      from: "now",
    });
    const exit = await a.call("bgmon_watch", {
      action: "add",
      monitorId: job.id,
      kind: "exit",
      from: "retained",
    });
    let list: any[] = [];
    for (let i = 0; i < 200; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      list = await a.call("bgmon_watch", { action: "list" });
      if (
        [retained, now, exit].every((w) => list.find((x: any) => x.id === w.id)?.state !== "active")
      )
        break;
    }
    assert.equal(list.find((w) => w.id === retained.id).state, "fired");
    assert.equal(list.find((w) => w.id === retained.id).prefixMissing, true);
    assert.equal(list.find((w) => w.id === now.id).state, "completed_no_match");
    const exitResult = list.find((w) => w.id === exit.id);
    assert.equal(exitResult.state, seen.state === "source_unverified" ? "failed" : "fired");
    if (seen.state === "source_unverified") assert.equal(exitResult.error, "source_unverified");
  } finally {
    await a.call("bgmon_control", { action: "server_stop" });
    await a.close();
  }
});

test("repeated TTL renewals do not multiply a stalled boundary read", async () => {
  const { Manager } = await import("../src/manager.ts");
  const a = runtime("renew-stalled-boundary");
  await a.start();
  const original = Manager.prototype.watchBoundary;
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let calls = 0;
  try {
    const job = await a.call("bgmon_start", { command: "sleep 15" });
    const watch = await a.call("bgmon_watch", {
      action: "add",
      monitorId: job.id,
      kind: "contains",
      pattern: "NEVER",
      ttlSeconds: 1,
    });
    Manager.prototype.watchBoundary = async function (id, stream) {
      if (id === job.id) {
        calls++;
        entered();
        await gate;
      }
      return original.call(this, id, stream);
    };
    await waitForBackground(started);
    for (let i = 0; i < 3; i++) {
      assert.equal(
        (await a.call("bgmon_watch", { action: "update", watchId: watch.id, ttlSeconds: 1 })).state,
        "active",
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const state = (await a.call("bgmon_watch", { action: "list" })).find(
      (w: any) => w.id === watch.id,
    );
    assert.equal(state.state, "failed");
    assert.equal(state.error, "expiry_boundary_unavailable");
    assert.equal(calls, 1);
  } finally {
    Manager.prototype.watchBoundary = original;
    release();
    await a.call("bgmon_control", { action: "server_stop" });
    await a.close();
  }
});

test("stalled watch initialization does not block control or install into a closed binding", async () => {
  const { Manager } = await import("../src/manager.ts");
  const a = runtime("init-slow-owner"),
    b = runtime("init-live-sibling");
  await a.start();
  await b.start();
  const original = Manager.prototype.watchStart;
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  try {
    const slow = await a.call("bgmon_start", { command: "sleep 10" });
    const fast = await b.call("bgmon_start", { command: "sleep 0.8; echo INIT_READY; sleep 3" });
    Manager.prototype.watchStart = async function (id, from, exit) {
      if (id === slow.id) {
        entered();
        await gate;
      }
      return original.call(this, id, from, exit);
    };
    const pending = a.call("bgmon_watch", { action: "add", monitorId: slow.id, kind: "any" });
    await started;
    const control = await Promise.race([
      a.call("bgmon_control", { action: "forget", id: slow.id }),
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 800)),
    ]);
    assert.ok(control, "control must not wait for watch initialization");
    assert.match(control.error, /running/);
    const watch = await b.call("bgmon_watch", {
      action: "add",
      monitorId: fast.id,
      kind: "contains",
      pattern: "INIT_READY",
    });
    await a.close();
    release();
    assert.match((await pending).error, /binding or source changed/);
    let state: any = {};
    for (let i = 0; i < 200 && state.state !== "fired"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      state =
        (await b.call("bgmon_watch", { action: "list" })).find((w: any) => w.id === watch.id) ?? {};
    }
    assert.equal(state.state, "fired");
    assert.equal(a.messages.length, 0);
  } finally {
    Manager.prototype.watchStart = original;
    release();
    await b.call("bgmon_control", { action: "server_stop" });
    await a.close();
    await b.close();
  }
});

test("expiry fails visibly if the only boundary includes post-deadline output", async () => {
  const { Manager } = await import("../src/manager.ts");
  const a = runtime("expiry-after-deadline");
  await a.start();
  const original = Manager.prototype.watchBoundary;
  try {
    const job = await a.call("bgmon_start", { command: "sleep 1.2; echo TOO_LATE; sleep 3" });
    const watch = await a.call("bgmon_watch", {
      action: "add",
      monitorId: job.id,
      kind: "contains",
      pattern: "TOO_LATE",
      ttlSeconds: 1,
    });
    Manager.prototype.watchBoundary = async function (id, stream) {
      if (id === job.id) await new Promise((resolve) => setTimeout(resolve, 600));
      return original.call(this, id, stream);
    };
    let state: any = {};
    for (let i = 0; i < 250; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      state =
        (await a.call("bgmon_watch", { action: "list" })).find((w: any) => w.id === watch.id) ?? {};
      if (state.state && state.state !== "active") break;
    }
    assert.equal(state.state, "failed");
    assert.equal(state.error, "expiry_boundary_unavailable");
    assert.equal(state.hits, 0);
  } finally {
    Manager.prototype.watchBoundary = original;
    await a.call("bgmon_control", { action: "server_stop" });
    await a.close();
  }
});

test("an eligible rotation gap resumes only from a valid paired checkpoint", async () => {
  const { Manager } = await import("../src/manager.ts");
  const { TextNormalizer } = await import("../src/text.mjs");
  const a = runtime("gap-checkpoint-resume");
  await a.start();
  const original = Manager.prototype.watchRead;
  try {
    const job = await a.call("bgmon_start", { command: "sleep 8" });
    const watch = await a.call("bgmon_watch", {
      action: "add",
      monitorId: job.id,
      kind: "contains",
      pattern: "ACTUAL_MATCH",
    });
    const parser = new TextNormalizer();
    const prefix = Buffer.from("\x1b]hidden");
    parser.write(prefix);
    const firstText = parser.snapshot();
    const data = Buffer.from("\nFALSE_PAYLOAD\x07ACTUAL_MATCH\n");
    let delivered = false;
    Manager.prototype.watchRead = async function (id, stream, after) {
      const page = await original.call(this, id, stream, after);
      if (id === job.id && !delivered) {
        delivered = true;
        return {
          ...page,
          first: 2,
          tail: 2,
          next: 2,
          gap: true,
          firstText,
          frames: [{ sequence: 2, start: prefix.length, end: prefix.length + data.length, data }],
        };
      }
      return page;
    };
    let state: any = {};
    for (let i = 0; i < 200 && state.state !== "fired"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      state =
        (await a.call("bgmon_watch", { action: "list" })).find((w: any) => w.id === watch.id) ?? {};
    }
    assert.equal(state.state, "fired");
    assert.equal(state.hits, 1);
    assert.equal(state.gaps, 1);
  } finally {
    Manager.prototype.watchRead = original;
    await a.call("bgmon_control", { action: "server_stop" });
    await a.close();
  }
});

test("post-deadline clean EOF cannot reuse an earlier output proof", async () => {
  const { Manager } = await import("../src/manager.ts");
  const a = runtime("expiry-eof-generation");
  await a.start();
  const original = Manager.prototype.watchBoundary;
  try {
    const job = await a.call("bgmon_start", {
      command: "sleep 0.3; printf FINAL_AFTER_EXPIRY; sleep 0.9",
    });
    const watch = await a.call("bgmon_watch", {
      action: "add",
      monitorId: job.id,
      kind: "contains",
      pattern: "FINAL_AFTER_EXPIRY",
      ttlSeconds: 1,
    });
    Manager.prototype.watchBoundary = async function (id, stream) {
      if (id === job.id) await new Promise((resolve) => setTimeout(resolve, 700));
      return original.call(this, id, stream);
    };
    let state: any = {};
    for (let i = 0; i < 250; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      state =
        (await a.call("bgmon_watch", { action: "list" })).find((w: any) => w.id === watch.id) ?? {};
      if (state.state && state.state !== "active") break;
    }
    assert.equal(state.state, "failed");
    assert.equal(state.error, "expiry_boundary_unavailable");
    assert.equal(state.hits, 0);
  } finally {
    Manager.prototype.watchBoundary = original;
    await a.call("bgmon_control", { action: "server_stop" });
    await a.close();
  }
});

test("removing a repeating watch flushes pending hits with their match positions", async () => {
  const a = runtime("remove-pending-hits");
  await a.start();
  try {
    const job = await a.call("bgmon_start", {
      command: "sleep 1; echo MATCH; sleep 1; echo MATCH; sleep 20",
    });
    const watch = await a.call("bgmon_watch", {
      action: "add",
      monitorId: job.id,
      kind: "contains",
      pattern: "MATCH",
      once: false,
    });
    const deadline = Date.now() + 6000;
    let info: any;
    do {
      await new Promise((resolve) => setTimeout(resolve, 50));
      info = (await a.call("bgmon_watch", { action: "list" })).find((w: any) => w.id === watch.id);
    } while (info.hits < 2 && Date.now() < deadline);
    assert.equal(info.hits, 2);
    assert.equal(
      (await a.call("bgmon_watch", { action: "remove", watchId: watch.id })).removed,
      true,
    );
    const events = (await a.call("bgmon_events", { action: "list" })).events.filter(
      (e: any) => e.watchId === watch.id && e.event === "matched",
    );
    assert.equal(
      events.reduce((n: number, e: any) => n + e.count, 0),
      2,
    );
    for (const e of events) {
      assert.ok(e.lastPosition.sequence > 0);
      assert.ok(e.lastPosition.normalizedOffsetUtf16 > 0);
      assert.equal(e.cursor, e.lastPosition.sequence);
    }
  } finally {
    await a.call("bgmon_control", { action: "server_stop" });
    await a.close();
  }
});

test("session shutdown invalidates binding before a stalled broker queue settles", async () => {
  const { broker } = await import("../src/broker.ts");
  const a = runtime("bounded-shutdown");
  await a.start();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const previous = (broker as any).current;
  await previous.pending;
  previous.pending = gate;
  try {
    const start = performance.now();
    await a.close();
    assert.ok(performance.now() - start < 2500);
    assert.match((await a.call("bgmon_events", { action: "list" })).error, /No active/);
  } finally {
    release();
    await previous.pending;
  }
});

test("stalled old broker mutations do not block or erase a fresh generation", async () => {
  const { broker } = await import("../src/broker.ts");
  const { Manager } = await import("../src/manager.ts");
  const a = runtime("generation-old"),
    b = runtime("generation-new");
  await a.start();
  const job = await a.call("bgmon_start", { command: "sleep 20" });
  assert.ok(job.id);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const original = Manager.prototype.jobs;
  Manager.prototype.jobs = async function () {
    if (this.session === "generation-old") {
      entered();
      await gate;
    }
    return original.call(this);
  };
  const previous = (broker as any).current;
  try {
    const blocked = a.call("bgmon_inspect", {});
    await waiting;
    assert.equal(previous.physical.mutations, 1);
    await a.close();
    await b.start();
    assert.equal((broker as any).current.physical, previous.physical);
    const starting = b.call("bgmon_start", { command: "sleep 20" });
    const fresh = await Promise.race([
      starting,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("new generation blocked")), 4000),
      ),
    ]);
    assert.ok(fresh.id);
    assert.equal(previous.physical.mutations, 1, "the old physical operation remains charged");
    release();
    await blocked;
    await previous.pending;
    assert.deepEqual(
      (await b.call("bgmon_inspect", {})).map((j: any) => j.id),
      [fresh.id],
    );
    assert.match((await b.call("bgmon_inspect", { id: job.id })).error, /Unknown monitor/);
    await b.call("bgmon_control", { action: "server_stop" });
  } finally {
    release();
    Manager.prototype.jobs = original;
    await b.close();
  }
});

test("shutdown during startup cannot launch an unreferenced command", async () => {
  const { LogStorage } = await import("../src/storage.ts");
  const { Tmux } = await import("../src/tmux.ts");
  const { stat } = await import("node:fs/promises");
  for (const point of ["reserve", "gate"] as const) {
    const a = runtime(`startup-detach-${point}`);
    await a.start();
    const marker = join(testStateHome, `ran-${point}`);
    const originalReserve = LogStorage.prototype.reserve;
    const originalStatus = Tmux.prototype.sourceStatus;
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    if (point === "reserve")
      LogStorage.prototype.reserve = async function (...args) {
        const result = await originalReserve.apply(this, args);
        entered();
        await gate;
        return result;
      };
    else
      Tmux.prototype.sourceStatus = async function (...args) {
        const result = await originalStatus.apply(this, args);
        entered();
        await gate;
        return result;
      };
    try {
      const starting = a.call("bgmon_start", { command: `touch '${marker}'` });
      await waiting;
      await a.close();
      release();
      const result = await starting;
      assert.match(result.error, /Session closed/);
      assert.equal(
        await stat(marker).then(
          () => true,
          () => false,
        ),
        false,
      );
      if (point === "reserve")
        assert.equal(
          a.entries.some((e: any) => e.customType === "pi-background-monitor:logref:v2"),
          false,
        );
    } finally {
      release();
      LogStorage.prototype.reserve = originalReserve;
      Tmux.prototype.sourceStatus = originalStatus;
      await a.close();
    }
  }
});

test("settled watch initialization releases physical capacity before queued installation", async () => {
  const { broker } = await import("../src/broker.ts");
  const { Manager } = await import("../src/manager.ts");
  const a = runtime("settled-init"),
    b = runtime("settled-init");
  await a.start();
  const job = await a.call("bgmon_start", { command: "sleep 20" });
  const original = Manager.prototype.watchStart;
  let releaseReads!: () => void, entered!: () => void, releaseQueue!: () => void;
  const reads = new Promise<void>((resolve) => {
    releaseReads = resolve;
  });
  const queue = new Promise<void>((resolve) => {
    releaseQueue = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let count = 0;
  Manager.prototype.watchStart = async function (...args) {
    const result = await original.apply(this, args);
    if (this.session === "settled-init") {
      if (++count === 4) entered();
      await reads;
    }
    return result;
  };
  const old = (broker as any).current;
  try {
    const watches = Array.from({ length: 4 }, () =>
      a.call("bgmon_watch", { action: "add", monitorId: job.id, kind: "any" }),
    );
    await waiting;
    await old.pending;
    old.pending = queue;
    releaseReads();
    for (
      let i = 0;
      i < 50 && [...old.physical.initializing.values()].some((x: any) => !x.settled);
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal([...old.physical.initializing.values()].filter((x: any) => x.settled).length, 4);
    await a.close();
    await b.start();
    Manager.prototype.watchStart = original;
    const fresh = await b.call("bgmon_start", { command: "sleep 20" });
    const watch = await b.call("bgmon_watch", { action: "add", monitorId: fresh.id, kind: "any" });
    assert.ok(watch.id, JSON.stringify(watch));
    releaseQueue();
    for (const result of await Promise.all(watches)) assert.match(result.error, /changed|closed/);
    await b.call("bgmon_control", { action: "server_stop" });
  } finally {
    releaseReads();
    releaseQueue();
    Manager.prototype.watchStart = original;
    await b.close();
  }
});

test("an unresolved release stays supervised and charged across binding shutdown", async () => {
  const { Tmux } = await import("../src/tmux.ts");
  const { broker } = await import("../src/broker.ts");
  const a = runtime("release-uncertain");
  await a.start();
  let release!: () => void, entered!: () => void, tm!: InstanceType<typeof Tmux>;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const original = Tmux.prototype.releaseCaptureGate;
  Tmux.prototype.releaseCaptureGate = async function (path) {
    tm = this;
    entered();
    await gate;
    return original.call(this, path);
  };
  const previous = (broker as any).current;
  try {
    const starting = a.call("bgmon_start", { command: "sleep 20" });
    await waiting;
    assert.equal((tm as any).pendingReleases.size, 1);
    await a.close();
    assert.equal((tm as any).captureTimers.size, 1);
    assert.equal(previous.physical.mutations, 1);
    release();
    const result = await starting;
    assert.ok(result.id, JSON.stringify(result));
    assert.equal((tm as any).pendingReleases.size, 0);
    assert.equal((tm as any).captureTimers.size, 0);
    assert.ok(["confirmed", "unknown"].includes(result.launch));
  } finally {
    release();
    Tmux.prototype.releaseCaptureGate = original;
    await a.close();
  }
});

test("stale stop and server-stop cannot control jobs after their binding closes", async () => {
  const { Manager } = await import("../src/manager.ts");
  for (const action of ["stop", "server_stop"] as const) {
    const a = runtime(`stale-control-${action}`),
      b = runtime(`observer-${action}`);
    await a.start();
    await b.start();
    const job = await a.call("bgmon_start", { command: "sleep 20" });
    const original = (Manager.prototype as any).status;
    let release!: () => void,
      entered!: () => void,
      blocked = false;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    (Manager.prototype as any).status = async function (...args: unknown[]) {
      const result = await original.apply(this, args);
      if (this.session === `stale-control-${action}` && !blocked) {
        blocked = true;
        entered();
        await gate;
      }
      return result;
    };
    try {
      const operation = a.call("bgmon_control", { action, id: job.id });
      await waiting;
      await a.close();
      release();
      assert.match((await operation).error, /Session closed/);
      assert.equal((await b.call("bgmon_inspect", { id: job.id })).state, "running");
      await b.call("bgmon_control", { action: "server_stop", id: job.id });
    } finally {
      release();
      (Manager.prototype as any).status = original;
      await a.close();
      await b.close();
    }
  }
});

test("closed bindings cannot forget or delete history after storage verification stalls", async () => {
  const { LogStorage } = await import("../src/storage.ts");
  for (const action of ["forget", "delete_history"] as const) {
    const a = runtime(`stale-delete-${action}`),
      observer = runtime(`delete-observer-${action}`);
    await a.start();
    await observer.start();
    const job = await a.call("bgmon_start", { command: "sleep 20" });
    await a.call("bgmon_control", { action: "server_stop" });
    if (action === "delete_history") {
      await a.close();
      await observer.close();
      await a.start();
      await observer.start();
    }
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const original = LogStorage.prototype.remove;
    LogStorage.prototype.remove = async function (...args) {
      entered();
      await gate;
      return original.apply(this, args);
    };
    try {
      const operation = a.call(
        "bgmon_control",
        action === "forget" ? { action, id: job.id } : { action, logRef: job.logRef },
      );
      await waiting;
      await a.close();
      release();
      assert.match((await operation).error, /Session closed/);
      const reopened = runtime(`stale-delete-${action}`, a.entries);
      await reopened.start();
      try {
        const history = await reopened.call("bgmon_inspect", { logRef: job.logRef });
        assert.equal(history.logRef.stream, job.logRef.stream);
      } finally {
        await reopened.close();
      }
    } finally {
      release();
      LogStorage.prototype.remove = original;
      await a.close();
      await observer.close();
    }
  }
});
