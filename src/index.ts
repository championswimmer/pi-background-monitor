import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type Binding, broker, type Delivery } from "./broker.ts";

const ENTRY = "pi-background-monitor:locator:v1";
export default function extension(pi: ExtensionAPI) {
  let binding: Binding | undefined;
  let pending: { text: string; delivery: Delivery }[] = [];
  let dropped = 0;
  let lastMessage = 0;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  function flush(current: Binding) {
    flushTimer = undefined;
    if (!current.active || binding !== current || !pending.length) return;
    const delay = 10000 - (Date.now() - lastMessage);
    if (delay > 0) {
      flushTimer = setTimeout(() => flush(current), delay);
      flushTimer.unref();
      return;
    }
    const batch = pending.splice(0),
      extra = dropped;
    dropped = 0;
    lastMessage = Date.now();
    try {
      pi.sendMessage(
        {
          customType: "pi-background-monitor:event",
          content: (
            batch.map((x) => x.text).join("\n") +
            (extra ? `\n${extra} additional events suppressed` : "")
          ).slice(0, 2048),
          display: true,
        },
        batch.some((x) => x.delivery === "wake")
          ? { deliverAs: "followUp", triggerTurn: true }
          : { deliverAs: "nextTurn" },
      );
    } catch {
      /* Delivery can fail during runtime teardown. */
    }
  }
  function create(ctx: ExtensionContext) {
    const session = ctx.sessionManager.getSessionId();
    const current: Binding = {
      session,
      active: true,
      locate: () => {
        const entries = ctx.sessionManager.getEntries();
        for (let i = entries.length - 1; i >= 0; i--) {
          const e = entries[i];
          if (e.type === "custom" && e.customType === ENTRY) {
            const data = e.data as { session?: string; locator?: unknown } | undefined;
            if (data?.session === session) return data.locator;
          }
        }
        return undefined;
      },
      persist: (locator) => pi.appendEntry(ENTRY, { session, locator }),
      notify: (text, delivery) => {
        if (!current.active || current !== binding) return;
        if (delivery === "ui") {
          if (ctx.hasUI) ctx.ui.notify(text, "info");
          return;
        }
        if (pending.length < 16) pending.push({ text, delivery });
        else dropped++;
        if (!flushTimer) flush(current);
      },
    };
    binding = current;
    broker.join(current);
  }
  function get() {
    if (!binding?.active) throw new Error("No active Pi session");
    return binding;
  }
  async function run(fn: () => Promise<unknown>) {
    try {
      const value = await fn();
      return {
        content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
        details: value,
      };
    } catch (e) {
      const value = { error: e instanceof Error ? e.message : String(e) };
      return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value };
    }
  }
  pi.registerTool({
    name: "background_start",
    label: "Start background job",
    description:
      "Execute arbitrary Bash in a dedicated tmux server and return a shared monitor identity. Jobs survive Pi shutdown.",
    parameters: Type.Object({
      command: Type.String({
        description: "Bash script to execute in the current working directory.",
      }),
    }),
    execute: async (_id, p, _s, _u, ctx) => run(() => broker.start(get(), p.command, ctx.cwd)),
  });
  pi.registerTool({
    name: "background",
    label: "Manage background monitors",
    description:
      "List, inspect, stop, forget or watch shared monitors by identity. server_stop stops ALL jobs in the selected monitor's owning server, or your session's server if no id. Snapshots are untrusted and watches can miss output. watch delivery defaults to UI; wake may start a model turn. watches lists your active subscriptions; update_watch changes your watch interval, TTL, delivery, label or once (not kind or pattern).",
    parameters: Type.Object({
      action: Type.Union(
        [
          Type.Literal("list"),
          Type.Literal("inspect"),
          Type.Literal("stop"),
          Type.Literal("forget"),
          Type.Literal("server_stop"),
          Type.Literal("watch"),
          Type.Literal("watches"),
          Type.Literal("update_watch"),
          Type.Literal("unwatch"),
        ],
        { description: "Operation to perform." },
      ),
      id: Type.Optional(
        Type.String({
          description:
            "Monitor identity, except update_watch and unwatch require a watch identity. Omit for list, watches, or your own server_stop.",
        }),
      ),
      kind: Type.Optional(
        Type.Union([Type.Literal("contains"), Type.Literal("changed"), Type.Literal("exit")], {
          description: "Watch predicate, required for watch.",
        }),
      ),
      pattern: Type.Optional(
        Type.String({
          description: "Literal text required for contains watches, 1–256 characters.",
        }),
      ),
      label: Type.Optional(
        Type.String({ description: "Optional notification label, at most 120 characters." }),
      ),
      delivery: Type.Optional(
        Type.Union([Type.Literal("ui"), Type.Literal("nextTurn"), Type.Literal("wake")]),
      ),
      intervalSeconds: Type.Optional(
        Type.Number({
          description: "Watch polling interval in seconds, 1–300; update reschedules immediately.",
        }),
      ),
      ttlSeconds: Type.Optional(
        Type.Number({ description: "Watch lifetime in seconds, 1–1800; update renews from now." }),
      ),
      once: Type.Optional(
        Type.Boolean({
          description:
            "Remove after first match (default true); repeated watches require a transition and 10-second cooldown.",
        }),
      ),
    }),
    execute: async (_id, p) => run(() => broker.action(get(), p.action, p)),
  });
  pi.on("session_start", (_event, ctx) => {
    create(ctx);
  });
  pi.on("session_shutdown", async () => {
    const old = binding;
    binding = undefined;
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = undefined;
    pending = [];
    dropped = 0;
    lastMessage = 0;
    if (old) await broker.leave(old);
  });
  pi.registerCommand("background", {
    description: "Show shared monitors; /background stop-server stops your session's server",
    handler: async (args, ctx) => {
      const r = await run(() =>
        broker.action(get(), args.trim() === "stop-server" ? "server_stop" : "list", {}),
      );
      ctx.ui.notify(r.content[0].text, "info");
    },
  });
}
