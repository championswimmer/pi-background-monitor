import assert from "node:assert/strict";
import { test } from "node:test";
import extension from "../src/index.ts";

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
    (await tools.get(name).execute("call", p, undefined, undefined, ctx)).details;
  try {
    const start = await execute("background_start", {
      command: "sleep 1; echo SECRET_READY; sleep 3",
    });
    assert.ok(start.id, JSON.stringify(start));
    const watch = await execute("background", {
      action: "watch",
      id: start.id,
      kind: "contains",
      pattern: "SECRET_READY",
      delivery: "wake",
      intervalSeconds: 1,
    });
    assert.ok(watch.id);
    await new Promise((r) => setTimeout(r, 2500));
    assert.equal(messages.length, 1);
    assert.doesNotMatch(messages[0][0].content, /SECRET_READY/);
    assert.deepEqual(messages[0][1], { deliverAs: "followUp", triggerTurn: true });
  } finally {
    await execute("background", { action: "server_stop" });
    await events.get("session_shutdown")({}, ctx);
  }
});

test("exit watch reports a lost pane while another job remains alive", async () => {
  const { readFile } = await import("node:fs/promises");
  const { dirname, join } = await import("node:path");
  const { checked } = await import("../src/tmux.ts");
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
    (await tools.get(name).execute("call", p, undefined, undefined, ctx)).details;
  try {
    const first = await execute("background_start", { command: "sleep 30" });
    const second = await execute("background_start", { command: "sleep 30" });
    assert.ok(first.id);
    assert.ok(second.id);
    const watch = await execute("background", {
      action: "watch",
      id: first.id,
      kind: "exit",
      delivery: "wake",
      intervalSeconds: 1,
    });
    assert.ok(watch.id);
    const registry = JSON.parse(
      await readFile(join(dirname(first.socket), "registry.json"), "utf8"),
    );
    await checked([
      "-S",
      first.socket,
      "kill-pane",
      "-t",
      registry.jobs.find((j: any) => j.id === first.id).pane,
    ]);
    const deadline = Date.now() + 6000;
    while (!messages.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.equal(messages.length, 1);
    assert.match(messages[0][0].content, /exit, lost/);
    assert.equal((await execute("background", { action: "inspect", id: first.id })).state, "lost");
    assert.equal(
      (await execute("background", { action: "list" })).find((j: any) => j.id === second.id).state,
      "running",
    );
  } finally {
    await execute("background", { action: "server_stop" });
    await events.get("session_shutdown")({}, ctx);
  }
});

function runtime(session: string, entries: any[] = []) {
  const tools = new Map<string, any>(),
    events = new Map<string, any>(),
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
    sessionManager: { getSessionId: () => session, getEntries: () => entries },
    ui: { notify: () => {} },
  };
  extension(pi);
  return {
    entries,
    messages,
    tools,
    start: () => events.get("session_start")({}, ctx),
    close: () => events.get("session_shutdown")({}, ctx),
    call: async (name: string, p: unknown) =>
      (await tools.get(name).execute("call", p, undefined, undefined, ctx)).details,
  };
}

test("shared identities, independent subscriptions, lifecycle and same-session recovery", async () => {
  const a = runtime("owner-shared"),
    b = runtime("subscriber-shared"),
    c = runtime("other-shared");
  await a.start();
  await b.start();
  await c.start();
  let id = "";
  try {
    assert.deepEqual([...a.tools.keys()], ["background_start", "background"]);
    const job = await a.call("background_start", {
      command: "sleep 2; echo SHARED_SECRET; sleep 30",
    });
    id = job.id;
    assert.ok(id, JSON.stringify(job));
    assert.ok((await b.call("background", { action: "list" })).some((j: any) => j.id === id));
    assert.equal((await b.call("background", { action: "inspect", id })).state, "running");
    const watch1 = await b.call("background", {
      action: "watch",
      id,
      kind: "contains",
      pattern: "SHARED_SECRET",
      delivery: "wake",
      intervalSeconds: 1,
    });
    const watch2 = await c.call("background", {
      action: "watch",
      id,
      kind: "contains",
      pattern: "SHARED_SECRET",
      delivery: "nextTurn",
      intervalSeconds: 1,
    });
    assert.ok(watch1.id && watch2.id);
    assert.match(
      (await c.call("background", { action: "unwatch", id: watch1.id })).error,
      /Unknown watch/,
    );
    assert.equal(
      (
        await b.call("background", {
          action: "update_watch",
          id: watch1.id,
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
    assert.equal((await c.call("background", { action: "inspect", id })).state, "running");
    await b.close();
    await c.close();
    const recovered = runtime("owner-shared", a.entries);
    await recovered.start();
    try {
      assert.ok(
        (await recovered.call("background", { action: "list" })).some((j: any) => j.id === id),
      );
      assert.equal(
        (await recovered.call("background", { action: "server_stop", id })).stopped,
        true,
      );
      id = "";
    } finally {
      await recovered.close();
    }
  } finally {
    if (id) {
      const cleanup = runtime("owner-shared", a.entries);
      await cleanup.start();
      await cleanup.call("background", { action: "server_stop", id });
      await cleanup.call("background", { action: "server_stop" });
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
    const job = await a.call("background_start", { command: "sleep 1; echo TARGET; sleep 15" });
    assert.ok(job.id);
    for (let i = 0; i < 8; i++)
      assert.ok(
        (
          await a.call("background", {
            action: "watch",
            id: job.id,
            kind: "contains",
            pattern: "TARGET",
            delivery: "wake",
          })
        ).id,
      );
    assert.match(
      (await a.call("background", { action: "watch", id: job.id, kind: "exit" })).error,
      /Maximum 8/,
    );
    const invalid = await a.call("background", {
      action: "update_watch",
      id: (await a.call("background", { action: "watches" }))[0].id,
      ttlSeconds: 5000,
    });
    assert.match(invalid.error, /TTL/);
    await a.close();
    await new Promise((r) => setTimeout(r, 1800));
    assert.equal(a.messages.length, 0);
    const reopened = runtime("watch-limit", a.entries);
    await reopened.start();
    try {
      assert.deepEqual(await reopened.call("background", { action: "watches" }), []);
      await reopened.call("background", { action: "server_stop" });
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
  assert.deepEqual([...a.extensions[0].tools.keys()], ["background_start", "background"]);
  assert.deepEqual([...b.extensions[0].tools.keys()], ["background_start", "background"]);
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
    job = await first.call("background_start", { command: "sleep 2; echo LOADER_READY; sleep 20" });
    assert.ok(job.id, JSON.stringify(job));
    assert.equal(
      (await second.call("background", { action: "inspect", id: job.id })).state,
      "running",
    );
    const watch = await second.call("background", {
      action: "watch",
      id: job.id,
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
    assert.equal(
      (await second.call("background", { action: "inspect", id: job.id })).state,
      "running",
    );
    assert.equal(
      (await second.call("background", { action: "server_stop", id: job.id })).stopped,
      true,
    );
  } finally {
    if (job?.id) await second.call("background", { action: "server_stop", id: job.id });
    await first.close();
    await second.close();
  }
});

test("last close racing a new session serializes lock release and recovery", async () => {
  const a = runtime("race-owner");
  await a.start();
  const job = await a.call("background_start", { command: "sleep 20" });
  assert.ok(job.id);
  const closing = a.close();
  const b = runtime("race-owner", a.entries);
  await b.start();
  try {
    const listing = await b.call("background", { action: "list" });
    assert.ok(Array.isArray(listing), JSON.stringify(listing));
    assert.ok(listing.some((j: any) => j.id === job.id));
    await closing;
  } finally {
    await b.call("background", { action: "server_stop" });
    await b.close();
    await closing;
  }
});

test("broken own locator cannot block known shared identities or watch cleanup", async () => {
  const a = runtime("healthy-owner"),
    b = runtime("bad-locator");
  await a.start();
  await b.start();
  try {
    const job = await a.call("background_start", { command: "sleep 20" });
    assert.ok(job.id);
    const watch = await b.call("background", { action: "watch", id: job.id, kind: "exit" });
    assert.ok(watch.id);
    b.entries.push({
      type: "custom",
      customType: "pi-background-monitor:locator:v1",
      data: { session: "bad-locator", locator: { invalid: true } },
    });
    assert.match(
      (await b.call("background", { action: "list" })).error,
      /Invalid background server locator/,
    );
    assert.equal((await b.call("background", { action: "inspect", id: job.id })).state, "running");
    assert.equal(
      (await b.call("background", { action: "update_watch", id: watch.id, intervalSeconds: 4 }))
        .intervalSeconds,
      4,
    );
    assert.equal((await b.call("background", { action: "unwatch", id: watch.id })).removed, true);
    assert.equal((await b.call("background", { action: "server_stop", id: job.id })).stopped, true);
  } finally {
    await a.call("background", { action: "server_stop" });
    await a.close();
    await b.close();
  }
});
