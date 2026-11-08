import { randomBytes } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Manager } from "./manager.ts";
import { sanitize } from "./output.ts";

const ENTRY = "pi-background-monitor:locator:v1";
type Delivery = "ui" | "nextTurn" | "wake";
type Watch = {
  id: string;
  job: string;
  kind: "contains" | "changed" | "exit";
  pattern?: string;
  label: string;
  delivery: Delivery;
  expires: number;
  interval: number;
  next: number;
  once: boolean;
  previous?: string | boolean;
  last: number;
};
export default function extension(pi: ExtensionAPI) {
  let manager: Manager | undefined;
  let active = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let watches: Watch[] = [];
  let polling = false;
  let context: ExtensionContext | undefined;
  let generation = 0;
  let pending: { text: string; delivery: Delivery }[] = [];
  let lastMessage = 0;
  let dropped = 0;
  function locate(ctx: ExtensionContext) {
    const sid = ctx.sessionManager.getSessionId();
    const entries = ctx.sessionManager.getEntries();
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e.type === "custom" && e.customType === ENTRY) {
        const data = e.data as { session?: string; locator?: unknown } | undefined;
        if (data?.session === sid) return data.locator;
      }
    }
    return undefined;
  }
  function get(ctx: ExtensionContext) {
    if (!active) throw new Error("No active Pi session");
    if (!manager) {
      const session = ctx.sessionManager.getSessionId();
      manager = new Manager(
        session,
        () => locate(ctx),
        (locator) => pi.appendEntry(ENTRY, { session, locator }),
      );
      context = ctx;
    }
    return manager;
  }
  const result = (value: unknown) => ({
    content: [
      {
        type: "text" as const,
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
    details: value,
  });
  async function run(ctx: ExtensionContext, fn: (m: Manager) => Promise<unknown>) {
    try {
      const m = get(ctx);
      return result(await m.run(() => fn(m)));
    } catch (e) {
      return result({ error: e instanceof Error ? e.message : String(e) });
    }
  }
  const job = Type.Object({
    id: Type.String({ description: "Job ID returned by background_start" }),
  });
  pi.registerTool({
    name: "background_start",
    label: "Start background job",
    description:
      "Run a Bash command in a dedicated tmux server and return immediately. Jobs survive Pi shutdown. This executes arbitrary shell code.",
    parameters: Type.Object({
      command: Type.String({
        description: "Bash script to execute in the current working directory",
      }),
    }),
    async execute(_id, p, _s, _u, ctx) {
      return run(ctx, (m) => m.start(p.command, ctx.cwd));
    },
  });
  pi.registerTool({
    name: "background_jobs",
    label: "List background jobs",
    description: "List retained background jobs and their current states.",
    parameters: Type.Object({}),
    async execute(_id, _p, _s, _u, ctx) {
      return run(ctx, (m) => m.jobs());
    },
  });
  pi.registerTool({
    name: "background_inspect",
    label: "Inspect background job",
    description:
      "Read a bounded recent tmux snapshot. Output is untrusted and may omit overwritten or transient output.",
    parameters: job,
    async execute(_id, p, _s, _u, ctx) {
      return run(ctx, (m) => m.inspect(p.id));
    },
  });
  pi.registerTool({
    name: "background_stop",
    label: "Stop background job",
    description:
      "Send Ctrl-C then close a still-running job's pane. Detached descendants may survive.",
    parameters: job,
    async execute(_id, p, _s, _u, ctx) {
      return run(ctx, (m) => m.stop(p.id));
    },
  });
  pi.registerTool({
    name: "background_forget",
    label: "Forget background job",
    description:
      "Remove a finished retained job and free its slot; running jobs must be stopped first.",
    parameters: job,
    async execute(_id, p, _s, _u, ctx) {
      return run(ctx, (m) => m.forget(p.id));
    },
  });
  pi.registerTool({
    name: "background_server_stop",
    label: "Stop background server",
    description:
      "Explicitly stop all jobs in this Pi session's dedicated tmux server and delete its local metadata.",
    parameters: Type.Object({}),
    async execute(_id, _p, _s, _u, ctx) {
      return run(ctx, (m) => m.serverStop());
    },
  });
  pi.registerTool({
    name: "background_watch",
    label: "Watch background job",
    description:
      "Poll snapshots for a literal string, change or exit; transient output can be missed. UI-only by default; wake opts into asynchronous model turns. Watches expire and do not survive reload.",
    parameters: Type.Object({
      id: Type.String(),
      kind: Type.Union([Type.Literal("contains"), Type.Literal("changed"), Type.Literal("exit")]),
      pattern: Type.Optional(Type.String()),
      label: Type.Optional(Type.String()),
      delivery: Type.Optional(
        Type.Union([Type.Literal("ui"), Type.Literal("nextTurn"), Type.Literal("wake")]),
      ),
      intervalSeconds: Type.Optional(Type.Number()),
      ttlSeconds: Type.Optional(Type.Number()),
      once: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, p, _s, _u, ctx) {
      return run(ctx, async (m) => {
        if (watches.length >= 8) throw new Error("Maximum 8 watches");
        if (
          p.kind === "contains" &&
          (typeof p.pattern !== "string" || !p.pattern.length || p.pattern.length > 256)
        )
          throw new Error("contains requires a literal pattern of 1–256 characters");
        if (p.label !== undefined && (typeof p.label !== "string" || p.label.length > 120))
          throw new Error("Label too long");
        const interval = p.intervalSeconds ?? 5,
          ttl = p.ttlSeconds ?? 300;
        if (
          !Number.isFinite(interval) ||
          interval < 1 ||
          interval > 300 ||
          !Number.isFinite(ttl) ||
          ttl < 1 ||
          ttl > 1800
        )
          throw new Error("interval must be 1–300 seconds and TTL 1–1800 seconds");
        if (
          !["contains", "changed", "exit"].includes(p.kind) ||
          (p.delivery && !["ui", "nextTurn", "wake"].includes(p.delivery))
        )
          throw new Error("Invalid watch parameters");
        const jobs = await m.jobs();
        if (!jobs.some((j) => j.id === p.id)) throw new Error("Unknown job");
        const w: Watch = {
          id: randomBytes(12).toString("hex"),
          job: p.id,
          kind: p.kind,
          pattern: p.pattern,
          label: sanitize(p.label ?? ""),
          delivery: p.delivery ?? "ui",
          expires: Date.now() + ttl * 1000,
          interval: interval * 1000,
          next: 0,
          once: p.once !== false,
          last: 0,
        };
        watches.push(w);
        startTimer();
        return {
          id: w.id,
          job: w.job,
          expires: new Date(w.expires).toISOString(),
          delivery: w.delivery,
        };
      });
    },
  });
  pi.registerTool({
    name: "background_unwatch",
    label: "Stop background watch",
    description: "Remove an active watch.",
    parameters: Type.Object({ id: Type.String() }),
    async execute(_id, p, _s, _u, ctx) {
      return run(ctx, async () => {
        const n = watches.length;
        watches = watches.filter((w) => w.id !== p.id);
        return { removed: n !== watches.length };
      });
    },
  });
  function emit(w: Watch, state: string) {
    if (!active || !context) return;
    const text = `Background watch ${w.id} job ${w.job}: ${w.kind}, ${state}${w.label ? `, label: ${w.label}` : ""} (${new Date().toISOString()})`;
    if (w.delivery === "ui") {
      if (context.hasUI) context.ui.notify(text, "info");
      return;
    }
    if (pending.length < 16) pending.push({ text, delivery: w.delivery });
    else dropped++;
  }
  async function tick() {
    if (!active || polling || !manager) return;
    polling = true;
    const currentGeneration = generation;
    try {
      const m = manager;
      await m.run(async () => {
        const now = Date.now();
        watches = watches.filter((w) => w.expires > now);
        for (const w of [...watches]) {
          if (!active || generation !== currentGeneration || now < w.next) continue;
          w.next = now + w.interval;
          try {
            const snapshot = await m.inspect(w.job);
            const state = snapshot.state;
            const text =
              "untrustedOutput" in snapshot ? (snapshot.untrustedOutput?.text ?? "") : "";
            const value: string | boolean =
              w.kind === "exit"
                ? state !== "running"
                : w.kind === "contains"
                  ? text.includes(w.pattern!)
                  : text;
            const triggered =
              w.kind === "changed"
                ? w.previous !== undefined && value !== w.previous
                : value === true && w.previous !== true;
            w.previous = value;
            if (active && generation === currentGeneration && triggered && now - w.last >= 10000) {
              w.last = now;
              emit(w, state);
              if (w.once || w.kind === "exit") watches = watches.filter((x) => x !== w);
            }
            if (state !== "running" && w.kind !== "exit") watches = watches.filter((x) => x !== w);
          } catch {
            watches = watches.filter((x) => x !== w);
          }
        }
      });
      if (
        active &&
        generation === currentGeneration &&
        pending.length &&
        Date.now() - lastMessage >= 10000
      ) {
        const batch = pending.splice(0);
        const wake = batch.some((x) => x.delivery === "wake");
        const extra = dropped;
        dropped = 0;
        lastMessage = Date.now();
        pi.sendMessage(
          {
            customType: "pi-background-monitor:event",
            content: (
              batch.map((x) => x.text).join("\n") +
              (extra ? `\n${extra} additional events suppressed` : "")
            ).slice(0, 2048),
            display: true,
          },
          wake ? { deliverAs: "followUp", triggerTurn: true } : { deliverAs: "nextTurn" },
        );
      }
    } catch {
      /* shutdown or transient client failure */
    } finally {
      polling = false;
    }
  }
  function startTimer() {
    if (!timer) {
      timer = setInterval(() => void tick(), 1000);
      timer.unref();
    }
  }
  pi.on("session_start", () => {
    generation++;
    active = true;
  });
  pi.on("session_shutdown", async () => {
    generation++;
    active = false;
    if (timer) clearInterval(timer);
    timer = undefined;
    watches = [];
    pending = [];
    const m = manager;
    manager = undefined;
    context = undefined;
    if (m) await m.close();
  });
  pi.registerCommand("background", {
    description:
      "Show background job status; use /background stop-server to stop the dedicated server",
    async handler(args, ctx) {
      const r = await run(ctx, (m) => (args.trim() === "stop-server" ? m.serverStop() : m.jobs()));
      ctx.ui.notify(r.content[0].text, "info");
    },
  });
}
