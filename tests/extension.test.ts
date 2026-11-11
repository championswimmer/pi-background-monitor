import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import extension from "../src/index.ts";
import { checked, Tmux } from "../src/tmux.ts";

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
  assert.match(guidance, /miss transient output/);
  // Pi wraps custom sections in opening and closing tags.
  assert.ok(guidance.split("\n").length + 2 <= 5);
  handler({ systemPromptOptions: options });
  assert.equal(options.sections.background_monitor, guidance);
  options.selectedTools = ["bgmon_watch"];
  handler({ systemPromptOptions: options });
  assert.match(options.sections.background_monitor, /contains.*literal.*regex.*JavaScript/);
  assert.match(options.sections.background_monitor, /imsu/);
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
      intervalSeconds: 1,
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
      intervalSeconds: 1,
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
      ["bgmon_start", "bgmon_inspect", "bgmon_control", "bgmon_watch"],
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
      intervalSeconds: 1,
    });
    const watch2 = await c.call("bgmon_watch", {
      action: "add",
      monitorId: id,
      kind: "contains",
      pattern: "SHARED_SECRET",
      delivery: "nextTurn",
      intervalSeconds: 1,
    });
    assert.ok(watch1.id && watch2.id);
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
          intervalSeconds: 2,
        })
      ).intervalSeconds,
      2,
    );
    await a.close();
    const deadline = Date.now() + 7000;
    while ((!b.messages.length || !c.messages.length) && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 50));
    assert.equal(b.messages.length, 1);
    assert.equal(c.messages.length, 1);
    assert.doesNotMatch(b.messages[0][0].content, /SHARED_SECRET/);
    assert.deepEqual(c.messages[0][1], { deliverAs: "nextTurn" });
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
      ttlSeconds: 5000,
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
  const key = Symbol.for("pi-background-monitor:broker:v1");
  const before = (globalThis as any)[key];
  assert.ok(before);
  const a = await loadExtensions([resolve("src/index.ts")], process.cwd());
  const b = await loadExtensions([resolve("src/index.ts")], process.cwd());
  assert.deepEqual(a.errors, []);
  assert.deepEqual(b.errors, []);
  assert.deepEqual(
    [...a.extensions[0].tools.keys()],
    ["bgmon_start", "bgmon_inspect", "bgmon_control", "bgmon_watch"],
  );
  assert.deepEqual(
    [...b.extensions[0].tools.keys()],
    ["bgmon_start", "bgmon_inspect", "bgmon_control", "bgmon_watch"],
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
      intervalSeconds: 1,
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

test("last close racing a new session serializes lock release and recovery", async () => {
  const a = runtime("race-owner");
  await a.start();
  const job = await a.call("bgmon_start", { command: "sleep 20" });
  assert.ok(job.id);
  const closing = a.close();
  const b = runtime("race-owner", a.entries);
  await b.start();
  try {
    const listing = await b.call("bgmon_inspect", {});
    assert.ok(Array.isArray(listing), JSON.stringify(listing));
    assert.ok(listing.some((j: any) => j.id === job.id));
    await closing;
  } finally {
    await b.call("bgmon_control", { action: "server_stop" });
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
      (await b.call("bgmon_watch", { action: "update", watchId: watch.id, intervalSeconds: 4 }))
        .intervalSeconds,
      4,
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
          intervalSeconds: 300,
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
      ["bgmon_start", "bgmon_inspect", "bgmon_control", "bgmon_watch"],
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
      "label",
      "delivery",
      "intervalSeconds",
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
      intervalSeconds: 17,
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
      assert.match(narrow.at(-1), /^╰─+╯$/);
      assert.ok(narrow.every((line: string) => visibleWidth(line) === 30));
      component.handleInput("tui.select.cancel");
      assert.equal(closed, true);
    };
    await a.command("bgmon", "");
    await a.command("bgmon", "list");
    assert.match(output.join("\n"), /sleep 30 # dashboard example/);
    assert.match(output.join("\n"), /every 17s.*expires/);
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

test("regex watches validate inputs and notify on matching snapshots", async () => {
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
      intervalSeconds: 1,
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

test("slow regex watch is removed with metadata-only notice and literal watches still work", async () => {
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
      intervalSeconds: 1,
    });
    const literal = await a.call("bgmon_watch", {
      action: "add",
      monitorId: job.id,
      kind: "contains",
      pattern: "(a+)+b",
      intervalSeconds: 1,
    });
    assert.ok(regex.id && literal.id);
    const deadline = Date.now() + 7000;
    while (!a.messages.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.equal(a.messages.length, 1);
    assert.match(a.messages[0][0].content, /regex watch removed \(evaluation failed\)/);
    assert.doesNotMatch(a.messages[0][0].content, /\(a\+\)\+b|aaaa/);
    const watches = await a.call("bgmon_watch", { action: "list" });
    assert.deepEqual(
      watches.map((w: { id: string }) => w.id),
      [literal.id],
    );
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
    try {
      assert.deepEqual(await resumed.call("bgmon_inspect", {}), []);
      assert.equal((await resumed.call("bgmon_inspect", { logRef: job.logRef })).state, "unknown");
      assert.equal(
        (await resumed.call("bgmon_control", { action: "delete_history", logRef: job.logRef }))
          .deleted,
        true,
      );
    } finally {
      await resumed.close();
    }
  } finally {
    await owner.close();
  }
});
