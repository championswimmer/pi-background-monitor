import { randomBytes } from "node:crypto";
import { Manager, validId } from "./manager.ts";
import { sanitize } from "./output.ts";
import { RegexMatcher } from "./regex.ts";

type Delivery = "ui" | "nextTurn" | "wake";
type Binding = {
  session: string;
  active: boolean;
  locate: () => unknown;
  persist: (x: unknown) => void;
  notify: (text: string, delivery: Delivery) => void;
  limits: () => { maxOpen: number; maxTotal: number };
};
type Owner = { manager: Manager; binding?: Binding };
type Watch = {
  id: string;
  job: string;
  subscriber: Binding;
  kind: "contains" | "regex" | "changed" | "exit";
  pattern?: string;
  flags?: string;
  label: string;
  delivery: Delivery;
  expires: number;
  interval: number;
  next: number;
  once: boolean;
  previous?: string | boolean;
  last: number;
};
export type WatchOptions = {
  id?: string;
  kind?: "contains" | "regex" | "changed" | "exit";
  pattern?: string;
  flags?: string;
  label?: string;
  delivery?: Delivery;
  intervalSeconds?: number;
  ttlSeconds?: number;
  once?: boolean;
};

class Broker {
  readonly regexWatchVersion = 1;
  private regex = new RegexMatcher();
  private regexCursor = 0;
  private owners = new Map<string, Owner>();
  private monitors = new Map<string, Owner>();
  private subscribers = new Set<Binding>();
  private watches = new Map<string, Watch>();
  private pending: Promise<unknown> = Promise.resolve();
  private timer?: ReturnType<typeof setInterval>;
  private polling = false;
  private run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.pending.then(fn);
    this.pending = next.catch(() => {});
    return next;
  }
  join(binding: Binding) {
    this.subscribers.add(binding);
  }
  private owner(binding: Binding): Owner {
    if (!binding.active) throw new Error("No active Pi session");
    let owner = this.owners.get(binding.session);
    if (!owner) {
      if (this.owners.size >= 128) throw new Error("Maximum 128 active monitor owners");
      owner = { manager: undefined as unknown as Manager, binding };
      const ref = owner;
      owner.manager = new Manager(
        binding.session,
        () => (ref.binding?.active ? ref.binding.locate() : undefined),
        (x) => {
          if (ref.binding?.active) ref.binding.persist(x);
        },
      );
      this.owners.set(binding.session, owner);
    } else owner.binding = binding;
    return owner;
  }
  private async recover(binding: Binding) {
    const owner = this.owner(binding);
    const jobs = await owner.manager.run(() => owner.manager.jobs());
    const unseen = jobs.filter((j) => !this.monitors.has(j.id));
    if (this.monitors.size + unseen.length > 64)
      throw new Error("Maximum 64 shared monitors; cannot index recovered jobs");
    for (const j of jobs) {
      const existing = this.monitors.get(j.id);
      if (existing && existing !== owner) throw new Error("Duplicate monitor identity");
    }
    const ids = new Set(jobs.map((j) => j.id));
    for (const [id, indexedOwner] of this.monitors)
      if (indexedOwner === owner && !ids.has(id)) {
        this.monitors.delete(id);
        for (const [wid, w] of this.watches) if (w.job === id) this.watches.delete(wid);
      }
    for (const j of jobs) {
      this.monitors.set(j.id, owner);
    }
    return owner;
  }
  private find(id?: string) {
    const owner = id && this.monitors.get(id);
    if (!owner) throw new Error("Unknown monitor identity");
    return owner;
  }
  private removeOwner(owner: Owner) {
    for (const [id, o] of this.monitors)
      if (o === owner) {
        this.monitors.delete(id);
        for (const [wid, w] of this.watches) if (w.job === id) this.watches.delete(wid);
      }
  }
  private async releaseEmptyOwner(owner: Owner) {
    if (owner.binding || [...this.monitors.values()].includes(owner)) return;
    for (const [session, candidate] of this.owners)
      if (candidate === owner) {
        this.owners.delete(session);
        await owner.manager.close();
        return;
      }
  }
  async leave(binding: Binding) {
    binding.active = false;
    this.subscribers.delete(binding);
    for (const [id, w] of this.watches) if (w.subscriber === binding) this.watches.delete(id);
    await this.run(async () => {
      for (const [id, w] of this.watches) if (w.subscriber === binding) this.watches.delete(id);
      for (const [session, owner] of this.owners) {
        if (owner.binding === binding)
          owner.binding = [...this.subscribers].find((b) => b.active && b.session === session);
        if (!owner.binding && ![...this.monitors.values()].includes(owner)) {
          this.owners.delete(session);
          await owner.manager.close();
        }
      }
      if (this.subscribers.size) return;
      if (this.timer) clearInterval(this.timer);
      this.timer = undefined;
      this.watches.clear();
      this.regex.close();
      this.monitors.clear();
      const owners = [...this.owners.values()];
      this.owners.clear();
      await Promise.all(owners.map((o) => o.manager.close()));
    });
  }
  start(binding: Binding, command: string, cwd: string, requestedId?: string) {
    return this.run(async () => {
      if (requestedId !== undefined && !validId(requestedId)) throw new Error("Invalid job ID");
      if (requestedId !== undefined && /^[a-f0-9]{24}$/.test(requestedId))
        throw new Error("ID uses reserved generated ID format");
      const owner = await this.recover(binding);
      if (requestedId !== undefined && this.monitors.has(requestedId))
        throw new Error("Duplicate monitor identity");
      if (this.monitors.size >= 64) throw new Error("Maximum 64 shared monitors");
      const jobs = await owner.manager.run(() => owner.manager.jobs());
      const limits = binding.limits();
      if (jobs.length >= limits.maxTotal)
        throw new Error(`Maximum ${limits.maxTotal} retained jobs; forget a finished job first`);
      if (jobs.filter((job) => job.state === "running").length >= limits.maxOpen)
        throw new Error(`Maximum ${limits.maxOpen} running jobs`);
      let jobId = requestedId;
      if (jobId === undefined) {
        do jobId = randomBytes(12).toString("hex");
        while (this.monitors.has(jobId));
      }
      const result = await owner.manager.run(() => owner.manager.start(command, cwd, jobId));
      this.monitors.set(result.id, owner);
      return result;
    });
  }
  action(binding: Binding, action: string, p: WatchOptions) {
    return this.run(async () => {
      if (!binding.active) throw new Error("No active Pi session");
      if (action === "list") {
        await this.recover(binding);
        const result = [];
        for (const owner of new Set(this.monitors.values()))
          result.push(...(await owner.manager.run(() => owner.manager.jobs())));
        return result;
      }
      if (action === "watches")
        return [...this.watches.values()]
          .filter((w) => w.subscriber === binding)
          .map((w) => this.watchInfo(w));
      if (action === "unwatch" || action === "update_watch") {
        const w = p.id && this.watches.get(p.id);
        if (!w || w.subscriber !== binding) throw new Error("Unknown watch identity");
        if (action === "unwatch") {
          this.watches.delete(w.id);
          return { removed: true };
        }
        this.configure(w, p);
        return this.watchInfo(w);
      }
      if (p.id && (!/^[a-f0-9]{24}$/.test(p.id) || !this.monitors.has(p.id)))
        await this.recover(binding);
      if (action === "server_stop") {
        const owner = p.id ? this.find(p.id) : this.owner(binding);
        const r = await owner.manager.run(() => owner.manager.serverStop());
        this.removeOwner(owner);
        await this.releaseEmptyOwner(owner);
        return r;
      }
      const owner = this.find(p.id);
      if (action === "inspect") return owner.manager.run(() => owner.manager.inspect(p.id!));
      if (action === "stop") return owner.manager.run(() => owner.manager.stop(p.id!));
      if (action === "forget") {
        const r = await owner.manager.run(() => owner.manager.forget(p.id!));
        this.monitors.delete(p.id!);
        for (const [id, w] of this.watches) if (w.job === p.id) this.watches.delete(id);
        await this.releaseEmptyOwner(owner);
        return r;
      }
      if (action === "watch") {
        if (
          this.watches.size >= 64 ||
          [...this.watches.values()].filter((w) => w.subscriber === binding).length >= 8
        )
          throw new Error("Maximum 8 watches per session and 64 shared watches");
        if (!p.kind || !["contains", "regex", "changed", "exit"].includes(p.kind))
          throw new Error("Invalid watch kind");
        if (
          (p.kind === "contains" || p.kind === "regex") &&
          (typeof p.pattern !== "string" || !p.pattern.length || p.pattern.length > 256)
        )
          throw new Error("contains and regex require a pattern of 1–256 characters");
        if (p.kind !== "contains" && p.kind !== "regex" && p.pattern !== undefined)
          throw new Error("pattern is only valid for contains or regex");
        if (
          p.flags !== undefined &&
          (p.kind !== "regex" ||
            typeof p.flags !== "string" ||
            !/^(?!.*(.).*\1)[imsu]*$/.test(p.flags))
        )
          throw new Error("Invalid regex flags (use unique i, m, s, u)");
        if (p.kind === "regex") {
          await this.regex.test(p.pattern!, p.flags ?? "");
          if (!binding.active) throw new Error("No active Pi session");
        }
        const w: Watch = {
          id: randomBytes(12).toString("hex"),
          job: p.id!,
          subscriber: binding,
          kind: p.kind,
          pattern: p.pattern,
          flags: p.flags,
          label: "",
          delivery: "ui",
          expires: Date.now() + 300000,
          interval: 5000,
          next: 0,
          once: true,
          last: 0,
        };
        this.configure(w, p);
        this.watches.set(w.id, w);
        if (!this.timer) {
          this.timer = setInterval(() => void this.tick(), 1000);
          this.timer.unref();
        }
        return this.watchInfo(w);
      }
      throw new Error("Unknown background action");
    });
  }
  private configure(w: Watch, p: WatchOptions) {
    if (p.label !== undefined && (typeof p.label !== "string" || p.label.length > 120))
      throw new Error("Label too long");
    if (p.delivery !== undefined && !["ui", "nextTurn", "wake"].includes(p.delivery))
      throw new Error("Invalid delivery");
    if (
      p.intervalSeconds !== undefined &&
      (!Number.isFinite(p.intervalSeconds) || p.intervalSeconds < 1 || p.intervalSeconds > 300)
    )
      throw new Error("interval must be 1–300 seconds");
    if (
      p.ttlSeconds !== undefined &&
      (!Number.isFinite(p.ttlSeconds) || p.ttlSeconds < 1 || p.ttlSeconds > 1800)
    )
      throw new Error("TTL must be 1–1800 seconds");
    if (p.label !== undefined) w.label = sanitize(p.label);
    if (p.delivery !== undefined) w.delivery = p.delivery;
    if (p.intervalSeconds !== undefined) {
      w.interval = p.intervalSeconds * 1000;
      w.next = 0;
    }
    if (p.ttlSeconds !== undefined) w.expires = Date.now() + p.ttlSeconds * 1000;
    if (p.once !== undefined) w.once = p.once;
  }
  private watchInfo(w: Watch) {
    return {
      id: w.id,
      job: w.job,
      kind: w.kind,
      delivery: w.delivery,
      intervalSeconds: w.interval / 1000,
      expires: new Date(w.expires).toISOString(),
      once: w.once,
      label: w.label,
    };
  }
  private async tick() {
    if (this.polling) return;
    this.polling = true;
    try {
      await this.run(async () => {
        const now = Date.now();
        const all = [...this.watches.values()];
        const regex = all.filter((w) => w.kind === "regex");
        const rotated = regex.slice(this.regexCursor).concat(regex.slice(0, this.regexCursor));
        let regexStart = 0;
        for (const w of [...all.filter((w) => w.kind !== "regex"), ...rotated]) {
          if (!w.subscriber.active || w.expires <= now) {
            this.watches.delete(w.id);
            continue;
          }
          if (now < w.next) continue;
          if (w.kind === "regex") {
            if (regexStart && Date.now() - regexStart >= 200) break;
            if (!regexStart) regexStart = Date.now();
            this.regexCursor = (regex.indexOf(w) + 1) % regex.length;
          }
          w.next = now + w.interval;
          try {
            const owner = this.find(w.job);
            const snapshot = await owner.manager.run(() => owner.manager.inspect(w.job));
            if (!w.subscriber.active || this.watches.get(w.id) !== w || w.expires <= Date.now())
              continue;
            const state = snapshot.state;
            const text =
              "untrustedOutput" in snapshot ? (snapshot.untrustedOutput?.text ?? "") : "";
            const value =
              w.kind === "exit"
                ? state !== "running"
                : w.kind === "contains"
                  ? text.includes(w.pattern!)
                  : w.kind === "regex"
                    ? await this.regex.test(w.pattern!, w.flags ?? "", text)
                    : text;
            if (!w.subscriber.active || this.watches.get(w.id) !== w || w.expires <= Date.now())
              continue;
            const triggered =
              w.kind === "changed"
                ? w.previous !== undefined && value !== w.previous
                : value === true && w.previous !== true;
            w.previous = value;
            if (triggered && now - w.last >= 10000) {
              w.last = now;
              w.subscriber.notify(
                `bgmon watch ${w.id} job ${w.job}: ${w.kind}, ${state}${w.label ? `, label: ${w.label}` : ""} (${new Date().toISOString()})`,
                w.delivery,
              );
              if (w.once || w.kind === "exit") this.watches.delete(w.id);
            }
            if (state !== "running" && w.kind !== "exit") this.watches.delete(w.id);
          } catch {
            if (w.kind === "regex" && w.subscriber.active && this.watches.get(w.id) === w)
              w.subscriber.notify(
                `bgmon watch ${w.id} job ${w.job}: regex watch removed (evaluation failed)`,
                w.delivery,
              );
            this.watches.delete(w.id);
          }
        }
        if (!this.watches.size && this.timer) {
          clearInterval(this.timer);
          this.timer = undefined;
        }
      });
    } finally {
      this.polling = false;
    }
  }
}
const key = Symbol.for("pi-background-monitor:broker:v1");
const global = globalThis as typeof globalThis & { [key: symbol]: unknown };
if (!global[key]) global[key] = new Broker();
export const broker = global[key] as Broker;
export type { Binding, Delivery };
