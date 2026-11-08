import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type Binding, broker, type Delivery } from "./broker.ts";
import { DEFAULT_LIMITS, dashboard, type Limits, settingsDialog, validLimits } from "./ui.ts";

const ENTRY = "pi-background-monitor:locator:v1";
const SETTINGS = "pi-background-monitor:settings:v1";
export default function extension(pi: ExtensionAPI) {
  let binding: Binding | undefined;
  let limits: Limits = { ...DEFAULT_LIMITS };
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
    limits = { ...DEFAULT_LIMITS };
    for (const e of ctx.sessionManager.getEntries()) {
      if (e.type === "custom" && e.customType === SETTINGS) {
        const data = e.data as { session?: string; limits?: unknown } | undefined;
        if (data?.session === session && validLimits(data.limits)) limits = { ...data.limits };
      }
    }
    const current: Binding = {
      session,
      limits: () => limits,
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
  // Pi normally validates the schema, but action-specific requirements also need
  // checking here (and inherited tool bridges may call execute directly).
  function fields(p: object, allowed: readonly string[]) {
    for (const key of Object.keys(p))
      if (!allowed.includes(key)) throw new Error(`Unexpected argument: ${key}`);
  }
  function identity(value: unknown, name: string, required = false) {
    if (value === undefined && !required) return;
    if (typeof value !== "string" || !value.trim())
      throw new Error(`${name} must be a non-empty identity`);
  }
  pi.registerTool({
    name: "bgmon_start",
    label: "Start bgmon job",
    description:
      "Execute arbitrary Bash in a dedicated tmux server and return a shared monitor identity. Jobs survive Pi shutdown.",
    parameters: Type.Object({
      command: Type.String({
        description: "Bash script to execute in the current working directory.",
      }),
    }),
    execute: async (_id, p, _s, _u, ctx) =>
      run(async () => {
        fields(p, ["command"]);
        return broker.start(get(), p.command, ctx.cwd);
      }),
  });
  pi.registerTool({
    name: "bgmon_inspect",
    label: "Inspect bgmon monitors",
    description:
      "List shared monitors when id is omitted, or inspect one monitor's bounded, untrusted output and state by id.",
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: "Monitor identity; omit to list monitors." })),
    }),
    execute: async (_id, p) =>
      run(async () => {
        fields(p, ["id"]);
        identity(p.id, "id");
        return broker.action(get(), p.id === undefined ? "list" : "inspect", p);
      }),
  });
  pi.registerTool({
    name: "bgmon_control",
    label: "Control bgmon jobs",
    description:
      "Stop or forget a monitor by id. server_stop stops ALL jobs in that monitor's owning server, or your session's server when id is omitted.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("stop"),
        Type.Literal("forget"),
        Type.Literal("server_stop"),
      ]),
      id: Type.Optional(
        Type.String({ description: "Monitor identity; required except for server_stop." }),
      ),
    }),
    execute: async (_id, p) =>
      run(async () => {
        fields(p, ["action", "id"]);
        if (!["stop", "forget", "server_stop"].includes(p.action))
          throw new Error("Invalid control action");
        identity(p.id, "id", p.action !== "server_stop");
        return broker.action(get(), p.action, p);
      }),
  });
  pi.registerTool({
    name: "bgmon_watch",
    label: "Manage bgmon watches",
    description:
      "Manage this session's independent monitor subscriptions. add needs monitorId and kind; update/remove need watchId; list takes no other arguments. Updates cannot change monitorId, kind or pattern. Snapshots can miss output; wake may start a model turn.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("add"),
        Type.Literal("list"),
        Type.Literal("update"),
        Type.Literal("remove"),
      ]),
      monitorId: Type.Optional(Type.String({ description: "Monitor identity for add." })),
      watchId: Type.Optional(
        Type.String({ description: "Subscription identity for update or remove." }),
      ),
      kind: Type.Optional(
        Type.Union([Type.Literal("contains"), Type.Literal("changed"), Type.Literal("exit")], {
          description: "Predicate required for add.",
        }),
      ),
      pattern: Type.Optional(
        Type.String({ description: "Literal text required for contains, 1–256 characters." }),
      ),
      label: Type.Optional(
        Type.String({ description: "Notification label, at most 120 characters." }),
      ),
      delivery: Type.Optional(
        Type.Union([Type.Literal("ui"), Type.Literal("nextTurn"), Type.Literal("wake")], {
          description: "Default ui; wake can start a model turn.",
        }),
      ),
      intervalSeconds: Type.Optional(
        Type.Number({
          description: "Polling interval 1–300 seconds; default 5. Update reschedules.",
        }),
      ),
      ttlSeconds: Type.Optional(
        Type.Number({
          description: "Lifetime 1–1800 seconds; default 300. Update renews from now.",
        }),
      ),
      once: Type.Optional(
        Type.Boolean({
          description:
            "Remove on first match; default true. Repeats require a transition and 10-second cooldown.",
        }),
      ),
    }),
    execute: async (_id, p) =>
      run(async () => {
        const options = ["label", "delivery", "intervalSeconds", "ttlSeconds", "once"];
        switch (p.action) {
          case "add":
            fields(p, ["action", "monitorId", "kind", "pattern", ...options]);
            identity(p.monitorId, "monitorId", true);
            if (!p.kind || !["contains", "changed", "exit"].includes(p.kind))
              throw new Error("add requires a valid kind");
            if (p.kind !== "contains" && p.pattern !== undefined)
              throw new Error("pattern is only valid for contains");
            return broker.action(get(), "watch", { ...p, id: p.monitorId });
          case "list":
            fields(p, ["action"]);
            return broker.action(get(), "watches", {});
          case "update":
            fields(p, ["action", "watchId", ...options]);
            identity(p.watchId, "watchId", true);
            return broker.action(get(), "update_watch", { ...p, id: p.watchId });
          case "remove":
            fields(p, ["action", "watchId"]);
            identity(p.watchId, "watchId", true);
            return broker.action(get(), "unwatch", { id: p.watchId });
          default:
            throw new Error("Invalid watch action");
        }
      }),
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
  pi.registerCommand("bgmon", {
    description: "Show monitors, configure settings, or stop your session's server",
    getArgumentCompletions: (prefix) => {
      const values = ["list", "settings", "stop-server"].filter((value) =>
        value.startsWith(prefix.trimStart()),
      );
      return values.length ? values.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      const command = args.trim();
      if (command && command !== "list" && command !== "settings" && command !== "stop-server") {
        ctx.ui.notify("Usage: /bgmon [list | settings | stop-server]", "info");
        return;
      }
      if (command === "settings") {
        if (!ctx.hasUI || ctx.mode !== "tui") {
          ctx.ui.notify("/bgmon settings requires TUI mode", "error");
          return;
        }
        const current = get();
        await settingsDialog(ctx, limits, (value) => {
          if (!current.active || current !== binding) return;
          limits = value;
          pi.appendEntry(SETTINGS, { session: current.session, limits });
        });
        return;
      }
      if (command === "stop-server") {
        const r = await run(() => broker.action(get(), "server_stop", {}));
        ctx.ui.notify(r.content[0].text, "info");
        return;
      }
      const r = await run(() => broker.action(get(), "list", {}));
      if (!ctx.hasUI || ctx.mode !== "tui" || !Array.isArray(r.details)) {
        ctx.ui.notify(r.content[0].text, "info");
        return;
      }
      const w = await run(() => broker.action(get(), "watches", {}));
      if (!Array.isArray(w.details)) {
        ctx.ui.notify(w.content[0].text, "error");
        return;
      }
      await dashboard(ctx, r.details, w.details);
    },
  });
}
