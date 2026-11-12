import { randomBytes } from "node:crypto";
import type { Delivery, WatchEvent } from "./broker.ts";

type Mode = Exclude<Delivery, "ui">;
type Entry = {
  watchId?: string;
  jobId?: string;
  stream?: string;
  firstCursor?: number;
  lastCursor?: number;
  firstPosition?: WatchEvent["firstPosition"];
  lastPosition?: WatchEvent["lastPosition"];
  kind?: string;
  event: string;
  order: number;
  notices: string[];
  noticeOverflow?: boolean;
  label?: string;
  events: number;
  hits: number;
  total?: number;
  details_coalesced: boolean;
  saturated?: boolean;
};
type Queue = { entries: Entry[]; overflow?: Entry };
type Channel = { queue: Queue; inFlight?: string; lastError?: string; disabled?: boolean };
const empty = (): Queue => ({ entries: [] });
const add = (a: number, b: number) => Math.min(Number.MAX_SAFE_INTEGER, a + b);
function merge(target: Entry, source: Entry) {
  const events = add(target.events, source.events),
    hits = add(target.hits, source.hits);
  target.saturated ||=
    source.saturated || events === Number.MAX_SAFE_INTEGER || hits === Number.MAX_SAFE_INTEGER;
  target.events = events;
  target.hits = hits;
  if (source.order >= target.order) {
    target.event = source.event;
    target.order = source.order;
    target.total = source.total;
  }
  for (const notice of source.notices) {
    if (target.notices.includes(notice)) continue;
    if (target.notices.length < 16) target.notices.push(notice);
    else target.noticeOverflow = true;
  }
  target.noticeOverflow ||= source.noticeOverflow;
  if (target.watchId && source.watchId === target.watchId) {
    if (source.firstCursor !== undefined)
      target.firstCursor = Math.min(target.firstCursor ?? source.firstCursor, source.firstCursor);
    if (source.lastCursor !== undefined)
      target.lastCursor = Math.max(target.lastCursor ?? source.lastCursor, source.lastCursor);
    const before = (
      a: NonNullable<WatchEvent["firstPosition"]>,
      b: NonNullable<WatchEvent["firstPosition"]>,
    ) =>
      a.sequence < b.sequence ||
      (a.sequence === b.sequence && a.normalizedOffsetUtf16 < b.normalizedOffsetUtf16);
    if (
      source.firstPosition &&
      (!target.firstPosition || before(source.firstPosition, target.firstPosition))
    )
      target.firstPosition = source.firstPosition;
    if (
      source.lastPosition &&
      (!target.lastPosition || before(target.lastPosition, source.lastPosition))
    )
      target.lastPosition = source.lastPosition;
  }
  target.details_coalesced = true;
}
function enqueue(
  queue: Queue,
  entry: Entry,
  detailLimit: number,
  summaryLimit: number,
  active: (id: string) => boolean,
) {
  if (queue.entries.length < detailLimit) {
    queue.entries.push(entry);
    return;
  }
  const summary = queue.entries.find((e) => e.details_coalesced && e.watchId === entry.watchId);
  if (summary) {
    merge(summary, entry);
    return;
  }
  if (queue.entries.length < detailLimit + summaryLimit) {
    queue.entries.push({ ...entry, details_coalesced: true });
    return;
  }
  if (!queue.overflow)
    queue.overflow = {
      event: "identities_omitted",
      order: 0,
      notices: [],
      events: 0,
      hits: 0,
      details_coalesced: true,
    };
  if (entry.watchId && active(entry.watchId)) {
    const index = queue.entries.findIndex(
      (item) => item.details_coalesced && item.watchId && !active(item.watchId),
    );
    if (index >= 0) {
      const [obsolete] = queue.entries.splice(index, 1);
      merge(queue.overflow, obsolete);
      queue.entries.push({ ...entry, details_coalesced: true });
      return;
    }
  }
  merge(queue.overflow, entry);
}
function makeEntry(event: WatchEvent, order: number): Entry {
  return {
    watchId: event.watchId,
    jobId: event.jobId,
    stream: event.stream,
    firstCursor: event.firstPosition?.sequence ?? event.cursor,
    lastCursor: event.lastPosition?.sequence ?? event.cursor,
    firstPosition: event.firstPosition,
    lastPosition: event.lastPosition,
    kind: event.kind,
    event: event.event,
    order,
    notices: event.event === "matched" ? [] : [event.event],
    label: event.label,
    events: 1,
    hits: event.count ?? 0,
    total: event.total,
    details_coalesced: false,
  };
}
function describe(entry: Entry) {
  if (!entry.watchId)
    return `bgmon details_coalesced: ${entry.events} events, ${entry.hits} hits; identities omitted${entry.notices.length ? `; notices: ${entry.notices.join("|")}${entry.noticeOverflow ? "|other" : ""}` : ""}${entry.saturated ? "; counter saturated" : ""}`;
  const base = `bgmon watch ${entry.watchId} job ${entry.jobId}: ${entry.kind}, ${entry.event}`;
  const counts = entry.details_coalesced
    ? `, details_coalesced: ${entry.events} events, ${entry.hits} hits`
    : entry.total === undefined
      ? ""
      : `, count: ${entry.hits}, total: ${entry.total}`;
  const notices =
    entry.details_coalesced && entry.notices.length
      ? `, notices: ${entry.notices.join("|")}${entry.noticeOverflow ? "|other" : ""}`
      : "";
  return `${base}${counts}${notices}${entry.label ? `, label: ${entry.label}` : ""}${entry.saturated ? "; counter saturated" : ""}`;
}

/** Bounded live-session inbox and best-effort model delivery; never persisted. */
export class LiveInbox {
  private log: WatchEvent[] = [];
  private logSummary = empty();
  private channels: Record<Mode, Channel> = {
    nextTurn: { queue: empty() },
    wake: { queue: empty() },
  };
  private sequence = 0;
  private lastSent = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;
  constructor(
    private readonly live: () => boolean,
    private readonly send: (mode: Mode, batchId: string, content: string) => void,
    private readonly ui: (text: string) => void,
    private readonly idle: () => boolean,
    private readonly activeWatch: (id: string) => boolean,
  ) {}
  push(event: WatchEvent, delivery: Delivery) {
    if (this.closed || !this.live()) return;
    this.sequence = add(this.sequence, 1);
    const order = this.sequence;
    if (this.log.length < 128) this.log.push(event);
    else enqueue(this.logSummary, makeEntry(event, order), 0, 8, this.activeWatch);
    if (delivery === "ui") {
      try {
        this.ui(describe(makeEntry(event, order)));
      } catch {
        /* Best-effort toast. */
      }
      return;
    }
    const channel = this.channels[delivery];
    enqueue(channel.queue, makeEntry(event, order), 16, 8, this.activeWatch);
    if (delivery === "wake") this.schedule();
  }
  /** nextTurn is injected at the actual run boundary, never queued in Pi. */
  beforeAgent() {
    if (
      this.closed ||
      !this.live() ||
      this.channels.nextTurn.inFlight ||
      Date.now() - this.lastSent < 10000
    )
      return undefined;
    const batch = this.take("nextTurn");
    return (
      batch && {
        customType: "pi-background-monitor:event",
        content: batch.content,
        display: true,
        details: { batchId: batch.batchId, mode: "nextTurn" as const },
      }
    );
  }
  resume() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.schedule();
  }
  list() {
    return {
      events: [...this.log],
      summaries: [...this.logSummary.entries],
      overflow: this.logSummary.overflow,
      delivery: Object.fromEntries(
        Object.entries(this.channels).map(([mode, c]) => [
          mode,
          {
            queued: c.queue.entries.length + (c.queue.overflow ? 1 : 0),
            inFlight: !!c.inFlight,
            confirmation: c.inFlight ? "unconfirmed" : undefined,
            error: c.lastError,
          },
        ]),
      ),
    };
  }
  status() {
    const coalesced = add(
      this.logSummary.entries.reduce((n, e) => add(n, e.events), 0),
      this.logSummary.overflow?.events ?? 0,
    );
    const channels = Object.values(this.channels);
    return {
      events: this.log.length,
      coalesced,
      queued: channels.reduce((n, c) => n + c.queue.entries.length + (c.queue.overflow ? 1 : 0), 0),
      inFlight: channels.filter((c) => c.inFlight).length,
    };
  }
  clear() {
    const removed = add(this.log.length, this.status().coalesced);
    this.log = [];
    this.logSummary = empty();
    return { cleared: removed, pendingDeliveryUnaffected: true };
  }
  observe(batchId: string, mode: Mode) {
    if (this.closed || !this.live()) return;
    const channel = this.channels[mode];
    if (channel.inFlight !== batchId) return;
    for (const c of Object.values(this.channels)) {
      if (c.inFlight === batchId) {
        c.inFlight = undefined;
        c.lastError = undefined;
      }
    }
    this.schedule();
  }
  close() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.log = [];
    this.logSummary = empty();
    for (const channel of Object.values(this.channels)) {
      channel.queue = empty();
      channel.inFlight = undefined;
    }
  }
  private schedule() {
    const channel = this.channels.wake;
    if (
      this.closed ||
      !this.live() ||
      this.timer ||
      channel.disabled ||
      channel.inFlight ||
      (!channel.queue.entries.length && !channel.queue.overflow)
    )
      return;
    try {
      if (!this.idle()) {
        this.timer = setTimeout(() => {
          this.timer = undefined;
          this.schedule();
        }, 1000);
        this.timer.unref();
        return;
      }
    } catch {
      channel.lastError = "context_unavailable";
      channel.disabled = true;
      return;
    }
    const delay = Math.max(0, 10000 - (Date.now() - this.lastSent));
    if (delay) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.schedule();
      }, delay);
      this.timer.unref();
      return;
    }
    const batch = this.take("wake");
    if (!batch) return;
    const next = !this.channels.nextTurn.inFlight
      ? this.take("nextTurn", batch.content, batch.batchId)
      : undefined;
    try {
      this.send("wake", batch.batchId, next?.content ?? batch.content);
      channel.lastError = undefined;
    } catch {
      // A synchronous throw is a known rejection; async failure is unobservable
      // through Pi's void API, so an unconfirmed submission is never resent.
      if (channel.inFlight === batch.batchId) {
        this.restore(channel, batch.taken);
        if (next) this.restore(this.channels.nextTurn, next.taken);
      }
    }
    this.schedule();
  }
  private restore(channel: Channel, taken: Entry[]) {
    channel.inFlight = undefined;
    const pending = [...taken, ...channel.queue.entries];
    if (channel.queue.overflow) pending.push(channel.queue.overflow);
    pending.sort((a, b) => a.order - b.order);
    channel.queue = empty();
    for (const entry of pending) enqueue(channel.queue, entry, 16, 8, this.activeWatch);
    channel.lastError = "submission_failed";
  }
  private take(mode: Mode, initial = "", existingBatchId?: string) {
    const channel = this.channels[mode],
      taken: Entry[] = [];
    let content = initial;
    while (channel.queue.entries.length || channel.queue.overflow) {
      const entry = channel.queue.overflow ?? channel.queue.entries[0];
      if (!entry) break;
      const line = describe(entry);
      const candidate = content ? `${content}\n${line}` : line;
      if (Buffer.byteLength(candidate) > 2048) break;
      if (channel.queue.overflow) channel.queue.overflow = undefined;
      else channel.queue.entries.shift();
      taken.push(entry);
      content = candidate;
    }
    if (!taken.length) return undefined;
    const batchId = existingBatchId ?? randomBytes(12).toString("hex");
    channel.inFlight = batchId;
    this.lastSent = Date.now();
    return { batchId, content, taken };
  }
}
