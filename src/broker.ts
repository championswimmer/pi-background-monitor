import { randomBytes } from "node:crypto";
import type { Frame } from "./journal.ts";
import { type LogCursor, Manager, validId } from "./manager.ts";
import { sanitize } from "./output.ts";
import { RegexMatcher } from "./regex.ts";
import type { LogRef } from "./storage.ts";
import { TextNormalizer } from "./text.mjs";
import { withTimeout } from "./tmux.ts";

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
type Operation<T> = {
  started: number;
  settledAt?: number;
  value?: T;
  failed?: boolean;
  error?: unknown;
};
type Watch = {
  id: string;
  job: string;
  subscriber: Binding;
  kind: "any" | "contains" | "regex" | "exit";
  pattern?: string;
  flags?: string;
  from: "now" | "retained";
  label: string;
  delivery: Delivery;
  once: boolean;
  deadline?: number;
  deadlineClock?: bigint;
  ttlGeneration: number;
  expiresAt?: number;
  expiryTail?: number;
  expiryHealth?: string;
  drainDeadline?: number;
  failureTail?: number;
  expired?: boolean;
  state: "active" | "fired" | "expired" | "completed_no_match" | "failed" | "source_removed";
  error?: string;
  stream: string;
  cursor: number;
  normalizer: TextNormalizer;
  skipPartial: boolean;
  partial: string;
  partialBytes: number;
  frames: Frame[];
  pending: string;
  pendingIndex: number;
  pendingSeq?: number;
  health: string;
  sourceState: string;
  capture?: string;
  tail: number;
  finalized: boolean;
  overflowReported: boolean;
  hits: number;
  pendingHits: number;
  gaps: number;
  prefixMissing: boolean;
  lastDelivery: number;
  readOp?: Operation<Awaited<ReturnType<Manager["watchRead"]>>>;
  expiryOp?: {
    generation: number;
    operation: Operation<Awaited<ReturnType<Manager["watchBoundary"]>>>;
  };
  failureOp?: Operation<Awaited<ReturnType<Manager["watchBoundary"]>>>;
  terminalIntegrity?: string;
  integrityError?: string;
  ioInFlight: number;
};
export type WatchOptions = {
  id?: string;
  kind?: "any" | "contains" | "regex" | "exit";
  pattern?: string;
  flags?: string;
  from?: "now" | "retained";
  label?: string;
  delivery?: Delivery;
  ttlSeconds?: number;
  once?: boolean;
  logRef?: LogRef;
  after?: LogCursor;
};

class Broker {
  private regex = new RegexMatcher();
  private watchCursor = 0;
  private ioInFlight = 0;
  private ownerIo = new Map<string, number>();
  private initializing = new Map<string, { binding: Binding; owner: Owner }>();
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
        for (const w of this.watches.values()) if (w.job === id) this.finish(w, "source_removed");
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
    if (action === "watch") return this.addWatch(binding, p);
    return this.run(async () => {
      if (!binding.active) throw new Error("No active Pi session");
      if (action === "history" || action === "delete_history") {
        const ref = p.logRef;
        if (!ref) throw new Error("A log reference is required");
        if (
          action === "delete_history" &&
          [...this.monitors.values()].some((owner) => owner.manager.hasRef(ref))
        )
          throw new Error("Use forget for an indexed monitor");
        const historical = new Manager(
          binding.session,
          () => undefined,
          () => {},
        );
        try {
          if (action === "history")
            return await historical.run(() => historical.inspectHistorical(ref, p.after));
          return await historical.run(() => historical.deleteHistorical(ref));
        } finally {
          await historical.close();
        }
      }
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
        return owner.manager.run(() => owner.manager.serverStop());
      }
      const owner = this.find(p.id);
      if (action === "inspect")
        return owner.manager.run(() => owner.manager.inspect(p.id!, p.after));
      if (action === "stop") return owner.manager.run(() => owner.manager.stop(p.id!));
      if (action === "forget") {
        const r = await owner.manager.run(() => owner.manager.forget(p.id!));
        this.monitors.delete(p.id!);
        for (const w of this.watches.values()) if (w.job === p.id) this.finish(w, "source_removed");
        await this.releaseEmptyOwner(owner);
        return r;
      }
      throw new Error("Unknown background action");
    });
  }
  private async addWatch(binding: Binding, p: WatchOptions) {
    const reservation = await this.run(async () => {
      if (!binding.active) throw new Error("No active Pi session");
      const pending = [...this.initializing.values()];
      if (
        this.watches.size + pending.length >= 64 ||
        [...this.watches.values()].filter((w) => w.subscriber === binding).length +
          pending.filter((v) => v.binding === binding).length >=
          8
      )
        throw new Error("Maximum 8 watches per session and 64 shared watches");
      if (!p.kind || !["any", "contains", "regex", "exit"].includes(p.kind))
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
        (p.kind !== "regex" || typeof p.flags !== "string" || !/^(?!.*(.).*\1)[iu]*$/.test(p.flags))
      )
        throw new Error("Invalid regex flags (use unique i, u)");
      if (p.from !== undefined && !["now", "retained"].includes(p.from))
        throw new Error("Invalid watch start position");
      this.validateOptions(p);
      if (p.kind === "regex") {
        try {
          new RegExp(p.pattern!, p.flags ?? "");
        } catch {
          throw new Error("Invalid regex syntax");
        }
      }
      const owner = this.find(p.id),
        jobId = p.id!;
      const ownerCount = pending.filter(
        (v) => v.owner.manager.session === owner.manager.session,
      ).length;
      if (
        this.ioInFlight + pending.length >= 16 ||
        (this.ownerIo.get(owner.manager.session) ?? 0) + ownerCount >= 4
      )
        throw new Error("Watch IO capacity exhausted; retry when pending operations settle");
      const token = randomBytes(12).toString("hex");
      this.initializing.set(token, { binding, owner });
      return { token, owner, jobId, kind: p.kind, from: p.from ?? "now" };
    });
    const { owner, jobId, from } = reservation;
    const pending = owner.manager.watchStart(jobId, from, reservation.kind === "exit");
    let settled = false;
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    try {
      const initial = await withTimeout(pending, 1000);
      return await this.run(async () => {
        if (
          !binding.active ||
          this.monitors.get(jobId) !== owner ||
          !owner.manager.hasSource(jobId, initial.stream)
        )
          throw new Error("Watch binding or source changed during initialization");
        const w: Watch = {
          id: randomBytes(12).toString("hex"),
          job: reservation.jobId,
          subscriber: binding,
          kind: reservation.kind,
          pattern: p.pattern,
          flags: p.flags,
          from,
          label: "",
          delivery: "ui",
          once: true,
          ttlGeneration: 0,
          state: "active",
          stream: initial.stream,
          cursor: initial.cursor,
          normalizer: initial.normalizer,
          skipPartial: initial.skipPartial,
          partial: "",
          partialBytes: 0,
          frames: [],
          pending: "",
          pendingIndex: 0,
          health: "ready",
          sourceState: "running",
          tail: initial.cursor,
          finalized: false,
          overflowReported: false,
          hits: 0,
          pendingHits: 0,
          gaps: initial.gap ? 1 : 0,
          prefixMissing: initial.prefixMissing,
          lastDelivery: 0,
          ioInFlight: 0,
        };
        this.configure(w, p);
        this.initializing.delete(reservation.token);
        this.watches.set(w.id, w);
        if (initial.gap) {
          this.notice(w, "history_gap");
          this.finish(w, "failed", "parser_uncertain_after_gap");
        } else if (initial.prefixMissing) this.notice(w, "retained_prefix_missing");
        if (!this.timer) {
          this.timer = setInterval(() => void this.tick(), 250);
          this.timer.unref();
        }
        return this.watchInfo(w);
      });
    } finally {
      const release = () =>
        this.run(async () => {
          this.initializing.delete(reservation.token);
        });
      if (settled) await release();
      else void pending.finally(() => void release()).catch(() => {});
    }
  }
  private validateOptions(p: WatchOptions) {
    if (p.label !== undefined && (typeof p.label !== "string" || p.label.length > 120))
      throw new Error("Label too long");
    if (p.delivery !== undefined && !["ui", "nextTurn", "wake"].includes(p.delivery))
      throw new Error("Invalid delivery");
    if (
      p.ttlSeconds !== undefined &&
      (!Number.isFinite(p.ttlSeconds) || p.ttlSeconds < 1 || p.ttlSeconds > 604800)
    )
      throw new Error("TTL must be 1–604800 seconds");
    if (p.once !== undefined && typeof p.once !== "boolean") throw new Error("Invalid once option");
  }
  private configure(w: Watch, p: WatchOptions) {
    if (w.state !== "active") throw new Error("Only active watches can be updated");
    this.validateOptions(p);
    if (p.label !== undefined) w.label = sanitize(p.label).replace(/\s+/g, " ");
    if (p.delivery !== undefined) w.delivery = p.delivery;
    if (p.ttlSeconds !== undefined) {
      w.ttlGeneration++;
      w.expired = false;
      w.deadline = performance.now() + p.ttlSeconds * 1000;
      w.deadlineClock = process.hrtime.bigint() + BigInt(Math.round(p.ttlSeconds * 1_000_000_000));
      w.expiresAt = Date.now() + p.ttlSeconds * 1000;
      w.expiryTail = undefined;
      w.expiryHealth = undefined;
    }
    if (p.once !== undefined) w.once = p.once;
  }
  private watchInfo(w: Watch) {
    return {
      id: w.id,
      job: w.job,
      kind: w.kind,
      from: w.from,
      delivery: w.delivery,
      expires: w.expiresAt === undefined ? undefined : new Date(w.expiresAt).toISOString(),
      once: w.once,
      label: w.label,
      state: w.state,
      hits: w.hits,
      gaps: w.gaps,
      prefixMissing: w.prefixMissing,
      cursor: w.cursor,
      tail: w.tail,
      error: w.error,
      expired: w.expired ?? false,
    };
  }
  private notice(w: Watch, kind: string, count?: number) {
    if (!w.subscriber.active || this.watches.get(w.id) !== w) return;
    try {
      w.subscriber.notify(
        `bgmon watch ${w.id} job ${w.job}: ${w.kind}, ${kind}${count === undefined ? "" : `, count: ${count}, total: ${w.hits}`}${w.label ? `, label: ${w.label}` : ""}`,
        w.delivery,
      );
    } catch {
      /* Delivery failure must not stop journal consumption. */
    }
  }
  private deliverHits(w: Watch, force = false) {
    if (!w.pendingHits || (!force && Date.now() - w.lastDelivery < 10000)) return;
    this.notice(w, "matched", w.pendingHits);
    w.pendingHits = 0;
    w.lastDelivery = Date.now();
  }
  private finish(w: Watch, state: Watch["state"], error?: string) {
    if (w.state !== "active") return;
    this.deliverHits(w, true);
    w.state = state;
    w.error = error;
    w.frames = [];
    w.pending = "";
    if (state !== "fired" || w.kind === "exit") this.notice(w, error ?? state);
  }
  private async line(w: Watch, line: string) {
    let matched = w.kind === "any" || (w.kind === "contains" && line.includes(w.pattern!));
    if (w.kind === "regex") {
      try {
        matched = await this.regex.test(w.pattern!, w.flags ?? "", line);
      } catch {
        this.finish(w, "failed", "regex_evaluation_failed");
        return;
      }
    }
    if (!w.subscriber.active || this.watches.get(w.id) !== w || w.state !== "active") return;
    if (!matched) return;
    if (w.hits === Number.MAX_SAFE_INTEGER || w.pendingHits === Number.MAX_SAFE_INTEGER) {
      this.finish(w, "failed", "hit_counter_exhausted");
      return;
    }
    w.hits++;
    w.pendingHits++;
    if (w.once) {
      const integrity =
        w.terminalIntegrity ??
        w.integrityError ??
        (w.health === "failed" ||
        w.capture === "incomplete" ||
        ["lost", "capture_failed"].includes(w.sourceState)
          ? "capture_incomplete"
          : undefined);
      this.finish(w, integrity ? "failed" : "fired", integrity);
    }
  }
  private async consume(w: Watch, budgetEnd: number) {
    let lines = 0;
    while (w.state === "active" && performance.now() < budgetEnd && lines < 200) {
      if (w.pendingSeq === undefined) {
        const next = w.frames.shift();
        if (!next) break;
        w.pending = w.normalizer.write(next.data);
        w.pendingIndex = 0;
        w.pendingSeq = next.sequence;
        if (w.normalizer.overflow && !w.overflowReported) {
          w.overflowReported = true;
          this.notice(w, "parser_overflow");
        }
      }
      while (
        w.pendingIndex < w.pending.length &&
        w.state === "active" &&
        lines < 200 &&
        performance.now() < budgetEnd
      ) {
        const code = w.pending.codePointAt(w.pendingIndex)!;
        const char = String.fromCodePoint(code);
        w.pendingIndex += char.length;
        if (char === "\n") {
          lines++;
          if (w.skipPartial) w.skipPartial = false;
          else await this.line(w, w.partial);
          w.partial = "";
          w.partialBytes = 0;
        } else if (!w.skipPartial) {
          w.partialBytes += Buffer.byteLength(char);
          if (w.partialBytes > 65536) {
            this.finish(w, "failed", "line_too_long");
            break;
          }
          w.partial += char;
        }
      }
      if (w.pendingIndex < w.pending.length || w.state !== "active") break;
      w.cursor = w.pendingSeq;
      w.pendingSeq = undefined;
      w.pending = "";
      w.pendingIndex = 0;
    }
  }
  private async flushFinal(w: Watch, budgetEnd: number) {
    if (!w.finalized) {
      w.finalized = true;
      w.pending = w.normalizer.end();
      w.pendingIndex = 0;
      w.pendingSeq = w.cursor;
      await this.consume(w, budgetEnd);
    }
    if (w.pendingSeq !== undefined || w.state !== "active") return false;
    if (!w.skipPartial && w.partial) {
      const partial = w.partial;
      w.partial = "";
      w.partialBytes = 0;
      await this.line(w, partial);
    }
    return w.state === "active";
  }
  private startIo<T>(w: Watch, owner: Owner, fn: () => Promise<T>): Operation<T> | undefined {
    const ownerKey = owner.manager.session;
    const initializingOwner = [...this.initializing.values()].filter(
      (entry) => entry.owner.manager.session === ownerKey,
    ).length;
    if (
      this.ioInFlight + this.initializing.size >= 16 ||
      (this.ownerIo.get(ownerKey) ?? 0) + initializingOwner >= 4 ||
      w.ioInFlight >= 2
    )
      return undefined;
    const operation: Operation<T> = { started: performance.now() };
    this.ioInFlight++;
    w.ioInFlight++;
    this.ownerIo.set(ownerKey, (this.ownerIo.get(ownerKey) ?? 0) + 1);
    void Promise.resolve()
      .then(fn)
      .then(
        (value) => {
          operation.value = value;
          operation.settledAt = performance.now();
        },
        (error) => {
          operation.failed = true;
          operation.error = error;
          operation.settledAt = performance.now();
        },
      )
      .finally(() => {
        this.ioInFlight--;
        w.ioInFlight--;
        const remaining = (this.ownerIo.get(ownerKey) ?? 1) - 1;
        if (remaining) this.ownerIo.set(ownerKey, remaining);
        else this.ownerIo.delete(ownerKey);
      });
    return operation;
  }
  private ioWaiting(w: Watch, operation?: Operation<unknown>) {
    const issue = operation
      ? performance.now() - operation.started >= 1000
        ? "read_stalled"
        : undefined
      : "io_capacity";
    if (issue && w.error !== issue) {
      w.error = issue;
      this.notice(w, issue);
    }
  }
  private ioResult<T>(w: Watch, operation: Operation<T>): T {
    if (operation.failed) throw operation.error;
    if (w.error === "read_stalled" || w.error === "io_capacity") {
      w.error = undefined;
      this.notice(w, "read_resumed");
    }
    return operation.value as T;
  }
  private readWatch(w: Watch, owner: Owner) {
    if (!w.readOp)
      w.readOp = this.startIo(w, owner, () =>
        w.kind === "exit"
          ? owner.manager.watchStatus(w.job, w.stream)
          : owner.manager.watchRead(w.job, w.stream, w.cursor),
      );
    const operation = w.readOp;
    if (!operation || operation.settledAt === undefined) {
      this.ioWaiting(w, operation);
      return undefined;
    }
    w.readOp = undefined;
    return this.ioResult(w, operation);
  }
  private watchBoundary(w: Watch, owner: Owner, kind: "expiry" | "failure") {
    if (kind === "expiry") {
      if (w.expiryOp && w.expiryOp.generation !== w.ttlGeneration) {
        if (w.expiryOp.operation.settledAt === undefined) {
          w.expired = true;
          this.finish(w, "failed", "expiry_boundary_unavailable");
          return undefined;
        }
        w.expiryOp = undefined;
      }
      if (!w.expiryOp) {
        const operation = this.startIo(w, owner, () =>
          owner.manager.watchBoundary(w.job, w.stream),
        );
        if (operation) w.expiryOp = { generation: w.ttlGeneration, operation };
        else {
          w.expired = true;
          this.finish(w, "failed", "expiry_boundary_unavailable");
          return undefined;
        }
      }
      const operation = w.expiryOp?.operation;
      if (!operation || operation.settledAt === undefined) {
        if (operation && performance.now() - operation.started >= 1000) {
          w.expired = true;
          this.finish(w, "failed", "expiry_boundary_unavailable");
        } else this.ioWaiting(w, operation);
        return undefined;
      }
      w.expiryOp = undefined;
      return this.ioResult(w, operation);
    }
    if (!w.failureOp)
      w.failureOp = this.startIo(w, owner, () => owner.manager.watchBoundary(w.job, w.stream));
    const operation = w.failureOp;
    if (!operation || operation.settledAt === undefined) {
      this.ioWaiting(w, operation);
      return undefined;
    }
    w.failureOp = undefined;
    return this.ioResult(w, operation);
  }
  private async advance(w: Watch, budgetEnd: number) {
    const owner = this.find(w.job);
    if (w.deadline !== undefined && performance.now() >= w.deadline && w.expiryTail === undefined) {
      if (w.kind === "exit") {
        const operation = w.readOp;
        const observed =
          operation?.settledAt !== undefined && operation.settledAt <= w.deadline
            ? operation.value?.status.state
            : undefined;
        if (observed && !["running", "capture_unverified"].includes(observed))
          this.finish(w, "fired", observed);
        else {
          w.expired = true;
          this.finish(w, "expired");
        }
        return;
      }
      const boundary = this.watchBoundary(w, owner, "expiry");
      if (!boundary || !w.subscriber.active || this.watches.get(w.id) !== w) return;
      if (
        !boundary.publishedClock ||
        w.deadlineClock === undefined ||
        BigInt(boundary.publishedClock) > w.deadlineClock
      ) {
        w.expired = true;
        this.finish(w, "failed", "expiry_boundary_unavailable");
        return;
      }
      w.expiryTail = boundary.tail;
      w.expiryHealth = boundary.health;
      w.tail = Math.max(w.tail, boundary.tail);
      w.health = boundary.health;
      if (boundary.health === "failed") w.integrityError = "capture_incomplete";
    }
    if (
      w.drainDeadline !== undefined &&
      performance.now() >= w.drainDeadline &&
      w.failureTail === undefined
    ) {
      const boundary = this.watchBoundary(w, owner, "failure");
      if (!boundary || !w.subscriber.active || this.watches.get(w.id) !== w) return;
      w.tail = Math.max(w.tail, boundary.tail);
      w.health = boundary.health;
      if (boundary.health === "failed") w.integrityError = "capture_incomplete";
      if (w.health === "ready") w.failureTail = boundary.tail;
    }
    if (!w.frames.length && w.pendingSeq === undefined) {
      const page = this.readWatch(w, owner);
      if (!page || !w.subscriber.active || this.watches.get(w.id) !== w) return;
      w.tail = Math.max(w.tail, page.tail);
      w.health = page.health;
      if (page.health === "failed") w.integrityError = "capture_incomplete";
      w.sourceState = page.status.state;
      w.capture = page.status.capture;
      if (page.gap) {
        w.gaps = Math.min(Number.MAX_SAFE_INTEGER, w.gaps + 1);
        this.notice(w, "history_gap");
        if (!page.firstText || page.frames[0]?.sequence !== page.first) {
          this.finish(w, "failed", "parser_uncertain_after_gap");
          return;
        }
        w.normalizer = new TextNormalizer(page.firstText);
        w.partial = "";
        w.partialBytes = 0;
        w.skipPartial = !w.normalizer.atLineBoundary || !!w.normalizer.snapshot().pending;
        w.overflowReported = false;
        w.cursor = page.first - 1;
      }
      const limit = Math.min(
        w.expiryTail ?? Number.MAX_SAFE_INTEGER,
        w.failureTail ?? Number.MAX_SAFE_INTEGER,
      );
      w.frames = page.frames.filter((f) => f.sequence <= limit);
      if (w.kind === "exit") {
        if (!["running", "capture_unverified"].includes(w.sourceState)) {
          this.finish(w, "fired", w.sourceState);
          return;
        }
        w.cursor = w.expiryTail === undefined ? page.tail : Math.min(page.tail, w.expiryTail);
        w.frames = [];
      }
    }
    await this.consume(w, budgetEnd);
    if (!w.subscriber.active || this.watches.get(w.id) !== w || w.state !== "active") return;
    this.deliverHits(w);
    const terminal = !["running", "capture_unverified"].includes(w.sourceState);
    if (w.kind !== "exit" && terminal && w.health === "ready" && w.drainDeadline === undefined)
      w.drainDeadline = performance.now() + (w.capture === "incomplete" ? 0 : 5000);
    const failure =
      !!w.integrityError ||
      w.health === "failed" ||
      w.capture === "incomplete" ||
      ["lost", "capture_failed"].includes(w.sourceState);
    const idle = !w.frames.length && w.pendingSeq === undefined;
    if (w.expiryTail !== undefined && w.cursor >= w.expiryTail && idle) {
      w.expired = true;
      if (w.kind !== "exit" && terminal && w.health === "ready" && w.failureTail === undefined)
        return;
      if (
        w.kind !== "exit" &&
        terminal &&
        w.health === "complete" &&
        w.expiryHealth === "complete" &&
        w.cursor >= w.tail
      ) {
        w.terminalIntegrity = failure ? "capture_incomplete" : undefined;
        if (!(await this.flushFinal(w, budgetEnd))) return;
      }
      if (w.kind !== "exit" && (failure || (terminal && w.failureTail !== undefined))) {
        this.finish(w, "failed", "capture_incomplete");
        return;
      }
      this.finish(w, "expired");
      return;
    }
    if (w.kind === "exit" || !idle) return;
    const observedLimit = Math.min(
      w.tail,
      w.failureTail ?? Number.MAX_SAFE_INTEGER,
      w.expiryTail ?? Number.MAX_SAFE_INTEGER,
    );
    if ((w.integrityError || w.health === "failed") && w.cursor >= observedLimit) {
      this.finish(w, "failed", "capture_incomplete");
      return;
    }
    if (terminal && w.failureTail !== undefined && w.cursor >= w.failureTail) {
      this.finish(w, "failed", "capture_incomplete");
      return;
    }
    if (terminal && w.health === "complete" && w.cursor >= w.tail) {
      w.terminalIntegrity = failure ? "capture_incomplete" : undefined;
      if (!(await this.flushFinal(w, budgetEnd))) return;
      this.finish(
        w,
        failure ? "failed" : w.hits ? "fired" : "completed_no_match",
        w.terminalIntegrity,
      );
    }
  }
  private async tick() {
    if (this.polling) return;
    this.polling = true;
    try {
      await this.run(async () => {
        const all = [...this.watches.values()].filter((w) => w.state === "active");
        const ordered = all.slice(this.watchCursor).concat(all.slice(0, this.watchCursor));
        const budgetEnd = performance.now() + 200;
        for (const w of ordered) {
          if (!w.subscriber.active) {
            this.watches.delete(w.id);
            continue;
          }
          try {
            await this.advance(w, budgetEnd);
          } catch {
            if (w.subscriber.active && this.watches.get(w.id) === w)
              this.finish(w, "failed", "watch_read_failed");
          }
          this.watchCursor = all.length ? (all.indexOf(w) + 1) % all.length : 0;
          if (performance.now() >= budgetEnd) break;
        }
        if (![...this.watches.values()].some((w) => w.state === "active") && this.timer) {
          clearInterval(this.timer);
          this.timer = undefined;
        }
      });
    } finally {
      this.polling = false;
    }
  }
}
const key = Symbol.for("pi-background-monitor:broker:v2");
const global = globalThis as typeof globalThis & { [key: symbol]: unknown };
if (!global[key]) global[key] = new Broker();
export const broker = global[key] as Broker;
export type { Binding, Delivery };
