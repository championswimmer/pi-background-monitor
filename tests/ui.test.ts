import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { DEFAULT_LIMITS, dashboard } from "../src/ui.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

test("output view polls serially, ignores stale results, and cancels on shutdown", async (t) => {
  initTheme("dark", false);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending: ReturnType<typeof deferred<unknown>>[] = [];
  const ids: string[] = [];
  let component: any;
  let renders = 0;
  let closed = 0;
  const controller = new AbortController();
  const ctx: any = {
    ui: {
      custom: async (factory: any) => {
        component = factory(
          { terminal: { rows: 24 }, requestRender: () => renders++ },
          {
            fg: (_: string, value: string) => value,
            bg: (_: string, value: string) => value,
            bold: (value: string) => value,
          },
          { matches: (data: string, key: string) => data === key },
          () => closed++,
        );
      },
    },
  };
  await dashboard(
    ctx,
    [
      { id: "one", state: "running" },
      { id: "two", state: "running" },
    ],
    [],
    DEFAULT_LIMITS,
    () => {},
    "list",
    undefined,
    {
      signal: controller.signal,
      inspect: (id) => {
        ids.push(id);
        const d = deferred<unknown>();
        pending.push(d);
        return d.promise;
      },
    },
  );
  component.handleInput("tui.select.confirm");
  assert.deepEqual(ids, ["one"]);
  assert.match(component.render(80).join("\n"), /Loading output/);
  t.mock.timers.tick(10000);
  assert.equal(ids.length, 1, "never overlap an unresolved request");
  component.handleInput("tui.select.cancel");
  component.handleInput("tui.select.down");
  component.handleInput("tui.select.confirm");
  assert.equal(ids.length, 1, "reopening waits for the old request");
  pending[0].resolve({
    id: "one",
    state: "running",
    untrustedOutput: { text: "STALE", truncated: false },
  });
  await flush();
  assert.deepEqual(ids, ["one", "two"]);
  assert.doesNotMatch(component.render(80).join("\n"), /STALE/);
  const content = `${Array.from({ length: 30 }, (_, i) => `line-${i}`).join("\n")}\n\x1b[31mSAFE\x1b[0m\tend`;
  pending[1].resolve({
    id: "two",
    state: "running",
    timestamp: "NOW",
    gap: true,
    untrustedOutput: { text: content, truncated: true },
  });
  await flush();
  assert.match(component.render(80).join("\n"), /history gap/);
  let output = component.render(40);
  assert.match(output.join("\n"), /SAFE {4}end/);
  assert.match(output.join("\n"), /truncated/);
  assert.equal(output.join("\n").includes("\x1b"), false);
  assert.ok(output.every((line: string) => visibleWidth(line) === 40));
  component.handleInput("tui.select.up");
  output = component.render(40);
  assert.match(output.join("\n"), /paused/);
  assert.doesNotMatch(output.join("\n"), /SAFE/);
  const paused = output.join("\n");
  t.mock.timers.tick(1999);
  assert.equal(ids.length, 2);
  t.mock.timers.tick(1);
  assert.equal(ids.length, 3);
  pending[2].resolve({
    id: "two",
    state: "running",
    timestamp: "NOW",
    gap: true,
    untrustedOutput: { text: `${content}\nNEW LINE`, truncated: true },
  });
  await flush();
  assert.equal(
    component.render(40).join("\n"),
    paused,
    "scroll position remains stable on refresh",
  );
  component.handleInput("\x1b[F");
  assert.match(component.render(40).join("\n"), /NEW LINE/);
  t.mock.timers.tick(2000);
  assert.equal(ids.length, 4);
  pending[3].reject(new Error("bad\x1b[31m error"));
  await flush();
  assert.match(component.render(40).join("\n"), /Refresh failed: bad error/);
  assert.match(component.render(40).join("\n"), /NEW LINE/);
  t.mock.timers.tick(2000);
  assert.equal(ids.length, 5);
  const before = renders;
  controller.abort();
  assert.equal(closed, 1);
  pending[4].resolve({
    id: "two",
    state: "running",
    untrustedOutput: { text: "LATE", truncated: false },
  });
  await flush();
  t.mock.timers.tick(10000);
  assert.equal(ids.length, 5);
  assert.equal(renders, before);
  component.dispose();
  assert.equal(closed, 1);
});

test("lost and empty snapshots remain usable at narrow and resized dimensions", async () => {
  initTheme("dark", false);
  let component: any;
  let closed = false;
  const terminal = { rows: 24 };
  const controller = new AbortController();
  const ctx: any = {
    ui: {
      custom: async (factory: any) => {
        component = factory(
          { terminal, requestRender() {} },
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
      },
    },
  };
  await dashboard(
    ctx,
    [
      { id: "lost", state: "lost" },
      { id: "empty", state: "running" },
    ],
    [],
    DEFAULT_LIMITS,
    () => {},
    "list",
    undefined,
    {
      signal: controller.signal,
      inspect: async (id) =>
        id === "lost"
          ? { id, state: "lost" }
          : {
              id,
              state: "running",
              clientTruncated: true,
              untrustedOutput: { text: "\n\n", truncated: false },
            },
    },
  );
  component.handleInput("tui.select.confirm");
  await flush();
  assert.match(component.render(80).join("\n"), /Output unavailable/);
  assert.match(component.render(80).join("\n"), /lost/);
  component.handleInput("tui.select.cancel");
  component.handleInput("tui.select.down");
  component.handleInput("tui.select.confirm");
  await flush();
  assert.match(component.render(80).join("\n"), /\(No output\)/);
  assert.match(component.render(80).join("\n"), /truncated/);
  terminal.rows = 14;
  const narrow = component.render(20);
  assert.ok(narrow.length <= terminal.rows);
  assert.ok(narrow.every((line: string) => visibleWidth(line) === 20));
  component.handleInput("tui.select.cancel");
  component.handleInput("tui.select.cancel");
  assert.equal(closed, true);
});

test("monitor dashboard renders origin and shared limits copy", async () => {
  let component: any;
  const ctx: any = {
    ui: {
      custom: async (factory: any) => {
        component = factory(
          { terminal: { rows: 30 }, requestRender() {} },
          {
            fg: (_: string, value: string) => value,
            bg: (_: string, value: string) => value,
            bold: (value: string) => value,
          },
          { matches: (data: string, key: string) => data === key },
          () => {},
        );
      },
    },
  };
  await dashboard(
    ctx,
    [{ id: "job", state: "running", origin: "/root/child", command: "echo hi" }],
    [],
    DEFAULT_LIMITS,
    () => {},
  );
  const list = component.render(100).join("\n");
  assert.match(list, /ORIGIN/);
  assert.match(list, /Origin: \/root\/child/);
  component.handleInput("\t");
  assert.match(component.render(100).join("\n"), /Limits shared with subagents/);
});
