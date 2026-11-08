import { test } from "node:test";
import assert from "node:assert/strict";
import extension from "../src/index.ts";

test("watch wakes only on selected event, not routine output; shutdown detaches", async () => {
  const tools = new Map<string, any>(), events = new Map<string, any>(), entries: any[] = [], messages: any[] = [];
  const pi: any = { registerTool: (t: any) => tools.set(t.name, t), on: (e: string, f: any) => events.set(e, f), registerCommand: () => {}, appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }), sendMessage: (...args: unknown[]) => messages.push(args) };
  const ctx: any = { cwd: process.cwd(), hasUI: false, sessionManager: { getSessionId: () => "test", getEntries: () => entries }, ui: { notify: () => {} } };
  extension(pi); await events.get("session_start")({}, ctx);
  const execute = async (name: string, p: unknown) => (await tools.get(name).execute("call", p, undefined, undefined, ctx)).details;
  try {
    const start = await execute("background_start", { command: "sleep 1; echo SECRET_READY; sleep 3" }); assert.ok(start.id, JSON.stringify(start));
    const watch = await execute("background_watch", { id: start.id, kind: "contains", pattern: "SECRET_READY", delivery: "wake", intervalSeconds: 1 }); assert.ok(watch.id);
    await new Promise(r => setTimeout(r, 2500));
    assert.equal(messages.length, 1); assert.doesNotMatch(messages[0][0].content, /SECRET_READY/); assert.deepEqual(messages[0][1], { deliverAs: "followUp", triggerTurn: true });
  } finally { await execute("background_server_stop", {}); await events.get("session_shutdown")({}, ctx); }
});
