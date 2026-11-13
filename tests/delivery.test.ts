import assert from "node:assert/strict";
import { test } from "node:test";
import type { WatchEvent } from "../src/broker.ts";
import { LiveInbox } from "../src/delivery.ts";

function event(n: number, watchId = "watch"): WatchEvent {
  return {
    id: String(n),
    watchId,
    jobId: "job",
    stream: "stream",
    kind: "contains",
    event: "matched",
    count: 1,
    total: n + 1,
    cursor: n,
    tail: n,
    timestamp: "now",
  };
}

test("delivery waits for message observation separately per mode", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 100000 });
  const sent: { mode: string; id: string; text: string }[] = [];
  const inbox = new LiveInbox(
    () => true,
    (mode, id, text) => sent.push({ mode, id, text }),
    () => {},
    () => true,
    () => true,
  );
  inbox.push(event(0), "wake");
  inbox.push(event(1), "wake");
  inbox.push(event(2), "nextTurn");
  assert.equal(sent.length, 1);
  t.mock.timers.tick(10000);
  assert.equal(sent.length, 1); // nextTurn is not submitted to Pi's uncancellable queue.
  const next = inbox.beforeAgent();
  assert.ok(next);
  assert.equal(next.details.mode, "nextTurn");
  t.mock.timers.tick(20000);
  assert.equal(sent.length, 1);
  inbox.observe("wrong", "wake");
  assert.equal(sent.length, 1);
  inbox.observe(sent[0].id, "wake");
  assert.equal(sent.length, 2);
  assert.equal(sent[1].mode, "wake");
  assert.ok(sent.every((item) => Buffer.byteLength(item.text) <= 2048));
  inbox.close();
  inbox.push(event(3), "wake");
  assert.equal(sent.length, 2);
});

test("synchronous observation and submission failure preserve bounded pending work", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 100000 });
  let inbox!: LiveInbox,
    calls = 0;
  inbox = new LiveInbox(
    () => true,
    (mode, id) => {
      calls++;
      if (calls === 1) throw new Error("injected");
      inbox.observe(id, mode);
    },
    () => {},
    () => true,
    () => true,
  );
  inbox.push(event(0), "wake");
  assert.equal((inbox.list().delivery.wake as { error?: string }).error, "submission_failed");
  t.mock.timers.tick(10000);
  assert.equal(calls, 2);
  assert.equal((inbox.list().delivery.wake as { inFlight: boolean }).inFlight, false);
  inbox.push(event(1), "wake");
  t.mock.timers.tick(10000);
  assert.equal(calls, 3);
  inbox.close();
});

test("headless events and coalesced delivery preserve aggregate counts", () => {
  const sent: string[] = [];
  const inbox = new LiveInbox(
    () => true,
    (_mode, _id, text) => sent.push(text),
    () => {},
    () => true,
    () => true,
  );
  for (let i = 0; i < 150; i++) inbox.push(event(i), i < 50 ? "ui" : "wake");
  const list = inbox.list();
  assert.equal(list.events.length, 128);
  assert.equal(list.summaries.length, 1);
  assert.equal(list.summaries[0].events, 22);
  assert.equal(list.summaries[0].hits, 22);
  const queue = (inbox as any).channels.wake.queue;
  assert.ok(queue.entries.length <= 24);
  assert.equal(
    queue.entries.reduce((sum: number, item: { hits: number }) => sum + item.hits, 0) +
      (queue.overflow?.hits ?? 0),
    99,
  );
  assert.equal(sent.length, 1);
  assert.equal(inbox.clear().cleared, 150);
  assert.equal(inbox.list().events.length, 0);
  inbox.close();
});

test("busy wake waits for idle and carries pending nextTurn in the same batch", () => {
  let idle = false;
  const sent: { id: string; text: string }[] = [];
  const inbox = new LiveInbox(
    () => true,
    (_mode, id, text) => sent.push({ id, text }),
    () => {},
    () => idle,
    () => true,
  );
  inbox.push(event(0, "wake-watch"), "wake");
  inbox.push(event(1, "next-watch"), "nextTurn");
  assert.equal(sent.length, 0);
  idle = true;
  inbox.resume();
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /wake-watch/);
  assert.match(sent[0].text, /next-watch/);
  assert.equal(inbox.list().delivery.wake.confirmation, "unconfirmed");
  assert.equal(inbox.list().delivery.nextTurn.confirmation, "unconfirmed");
  inbox.observe(sent[0].id, "wake");
  assert.equal(inbox.list().delivery.nextTurn.inFlight, false);
  inbox.close();
  assert.equal(inbox.beforeAgent(), undefined);
});

test("coalescing retains integrity notices and prioritizes current watch identities", () => {
  const active = new Set<string>();
  const inbox = new LiveInbox(
    () => true,
    () => {},
    () => {},
    () => true,
    (id) => active.has(id),
  );
  for (let i = 0; i < 128; i++) inbox.push(event(i, "initial"), "ui");
  for (let i = 0; i < 8; i++)
    inbox.push({ ...event(i, `old-${i}`), event: "history_gap", count: undefined }, "ui");
  active.add("current");
  inbox.push({ ...event(200, "current"), event: "history_gap", count: undefined }, "ui");
  inbox.push(event(201, "current"), "ui");
  const result = inbox.list();
  const current = result.summaries.find((e) => e.watchId === "current");
  assert.ok(current);
  assert.equal(current.event, "matched");
  assert.deepEqual(current.notices, ["history_gap"]);
  assert.equal(current.hits, 1);
  assert.equal(result.overflow?.events, 1);
  assert.ok(result.overflow?.notices.includes("history_gap"));
  inbox.close();
});

test("synchronous submission failure restores entries before newer arrivals", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 100000 });
  let inbox!: LiveInbox;
  let content = "";
  let calls = 0;
  inbox = new LiveInbox(
    () => true,
    (_mode, _id, text) => {
      calls++;
      if (calls === 1) {
        inbox.push(event(2), "wake");
        throw new Error("rejected");
      }
      content = text;
    },
    () => {},
    () => true,
    () => true,
  );
  inbox.push({ ...event(1), event: "history_gap", count: undefined }, "wake");
  t.mock.timers.tick(10000);
  assert.equal(calls, 2);
  assert.ok(content.indexOf("history_gap") < content.indexOf("matched"));
  inbox.close();
});

test("an invalidated Pi idle context cannot throw from a scheduled delivery timer", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 100000 });
  let disposed = false,
    calls = 0;
  let inbox!: LiveInbox;
  inbox = new LiveInbox(
    () => true,
    (mode, id) => {
      calls++;
      inbox.observe(id, mode);
    },
    () => {},
    () => {
      if (disposed) throw new Error("stale context");
      return true;
    },
    () => true,
  );
  inbox.push(event(0), "wake");
  inbox.push(event(1), "wake");
  disposed = true;
  assert.doesNotThrow(() => t.mock.timers.tick(10000));
  assert.equal(calls, 1);
  assert.equal(inbox.list().delivery.wake.error, "context_unavailable");
  inbox.push(event(2, "ui-watch"), "ui");
  inbox.push(event(3, "next-watch"), "nextTurn");
  assert.ok(inbox.list().events.some((e) => e.watchId === "ui-watch"));
  assert.match(inbox.beforeAgent()?.content ?? "", /next-watch/);
  inbox.close();
});

test("wake rechecks after a busy non-agent operation becomes idle", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 100000 });
  let idle = false,
    sent = 0;
  const inbox = new LiveInbox(
    () => true,
    () => {
      sent++;
    },
    () => {},
    () => idle,
    () => true,
  );
  inbox.push(event(0), "wake");
  t.mock.timers.tick(1000);
  assert.equal(sent, 0);
  idle = true;
  t.mock.timers.tick(1000);
  assert.equal(sent, 1);
  inbox.close();
});

test("coalesced overflow drains ahead of continuously arriving detail", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 100000 });
  const sent: { id: string; text: string }[] = [];
  const inbox = new LiveInbox(
    () => true,
    (_mode, id, text) => sent.push({ id, text }),
    () => {},
    () => true,
    () => true,
  );
  inbox.push(event(0), "wake");
  for (let i = 1; i < 40; i++) inbox.push(event(i, `watch-${i}`), "wake");
  assert.ok((inbox as any).channels.wake.queue.overflow);
  t.mock.timers.tick(10000);
  inbox.observe(sent[0].id, "wake");
  assert.equal(sent.length, 2);
  assert.match(sent[1].text, /identities omitted/);
  inbox.close();
});
