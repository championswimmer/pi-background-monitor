import { createHash, randomBytes } from "node:crypto";
import { lstat, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readJournal, readJournalTail, readPrivateFile } from "./journal.ts";
import { MAX_MONITORS } from "./limits.ts";
import { bounded, quote, sanitize } from "./output.ts";
import { readStopProof, writeStopProof } from "./proof.ts";
import { type LogRef, LogStorage } from "./storage.ts";
import { checked, createDirectory, probe, Tmux, withTimeout } from "./tmux.ts";

type Job = {
  id: string;
  created: string;
  command: string;
  ref: LogRef;
  dir: string;
  pane?: string;
  pid?: number;
  generation: number;
  cancelled?: boolean;
  failure?: string;
  final?: Status;
};
type Status = { state: string; exitCode?: number; signal?: string; capture?: string };
export type LogCursor = { sequence: number; offset: number };
const id = () => randomBytes(12).toString("hex");
function completeUtf8Prefix(data: Buffer, end: number) {
  let start = end - 1;
  while (start >= 0 && end - start <= 4 && (data[start] & 0xc0) === 0x80) start--;
  if (start < 0) return end;
  const byte = data[start];
  const expected =
    byte >= 0xc2 && byte <= 0xdf
      ? 2
      : byte >= 0xe0 && byte <= 0xef
        ? 3
        : byte >= 0xf0 && byte <= 0xf4
          ? 4
          : 1;
  return expected > end - start ? start : end;
}
export const validId = (x: unknown): x is string =>
  typeof x === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(x);

/** A controller is live-process scoped; stored references are data, not controllers. */
export class Manager {
  private readonly storage: LogStorage;
  private jobsById = new Map<string, Job>();
  private tm?: Tmux;
  private dir?: string;
  private generation = 0;
  private closed = false;
  private pending: Promise<unknown> = Promise.resolve();
  constructor(
    readonly session: string,
    _locate: () => unknown,
    readonly persist: (x: LogRef | null) => void,
    root?: string,
  ) {
    this.storage = new LogStorage(session, root);
  }
  run<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.pending.then(() => {
      if (this.closed) throw new Error("Session closed");
      return fn();
    });
    this.pending = p.catch(() => {});
    return p;
  }
  async close() {
    this.closed = true;
    await this.pending;
    this.tm?.stopCaptureSupervisors();
  }
  private async ensureTmux() {
    if (!this.tm) {
      await probe();
      const d = await createDirectory();
      this.dir = d.dir;
      this.tm = new Tmux(d.socket, d.dir, d.token);
    }
    return this.tm;
  }
  private async verified(): Promise<boolean> {
    if (!this.tm) return false;
    const s = await lstat(this.tm.socket).catch(() => undefined);
    if (!s) return false;
    if (!s.isSocket() || s.uid !== process.getuid?.()) throw new Error("Unsafe tmux socket");
    return this.tm.verify();
  }
  private find(jobId: string) {
    if (!validId(jobId)) throw new Error("Invalid job ID");
    const j = this.jobsById.get(jobId);
    if (!j) throw new Error("Unknown job");
    return j;
  }
  private async status(j: Job): Promise<Status> {
    if (j.final) return j.final;
    if (j.cancelled) return { state: "cancelled" };
    if (j.failure) return { state: "capture_failed", capture: "unknown" };
    const result = this.tm?.captureResult(j.dir) as Status | undefined;
    if (result) return result;
    if (!j.pane || !j.pid || j.generation !== this.generation)
      return { state: "lost", capture: "unknown" };
    try {
      if (!(await this.verified())) return { state: "capture_unverified", capture: "unknown" };
      const current = await this.tm!.sourceStatus(j.pane, j.ref.stream, j.pid);
      return current.state === "changed" ? { state: "lost", capture: "unknown" } : current;
    } catch {
      return { state: "capture_unverified", capture: "unknown" };
    }
  }
  async start(command: string, cwd: string, requestedId?: string) {
    if (requestedId !== undefined && !validId(requestedId)) throw new Error("Invalid job ID");
    if (typeof command !== "string" || !command.trim() || Buffer.byteLength(command) > 65536)
      throw new Error("Command must be 1–65536 bytes");
    if (!(await stat(cwd)).isDirectory()) throw new Error("cwd is not a directory");
    if (this.jobsById.size >= MAX_MONITORS)
      throw new Error(`Maximum ${MAX_MONITORS} retained jobs; forget a finished job first`);
    const jobId = requestedId ?? id();
    if ([...this.jobsById.keys()].some((x) => x.toLowerCase() === jobId.toLowerCase()))
      throw new Error("Duplicate monitor identity (case-insensitive within a server)");
    const tm = await this.ensureTmux();
    const { ref, dir } = await this.storage.reserve();
    const job: Job = {
      id: jobId,
      ref,
      dir,
      created: new Date().toISOString(),
      command: sanitize(command).replace(/\s+/g, " ").slice(0, 512),
      generation: 0,
    };
    try {
      const script = join(dir, "command.sh");
      await writeFile(script, command, { mode: 0o600, flag: "wx" });
      const source = await readFile(fileURLToPath(new URL("./capture.mjs", import.meta.url)));
      const hash = createHash("sha256").update(source).digest("hex");
      const runtime = join(dir, `capture-${hash}.mjs`);
      await writeFile(runtime, source, { mode: 0o600, flag: "wx" });
      this.persist(ref);
      this.jobsById.set(job.id, job);
      const first = !(await this.verified());
      if (first && this.generation > 0) {
        for (const existing of this.jobsById.values()) {
          if (existing === job || existing.generation !== this.generation || !existing.pane)
            continue;
          if (["running", "capture_unverified"].includes((await this.status(existing)).state))
            throw new Error(
              "Cannot restart an unverified server while a producer may still be running",
            );
        }
      }
      if (first) this.generation++;
      job.generation = this.generation;
      const start = await tm.startCaptured(
        script,
        cwd,
        first,
        dir,
        runtime,
        ref.stream,
        async (pane, pid) => {
          job.pid = pid;
          await writeFile(
            join(dir, "producer.json"),
            JSON.stringify({
              version: 1,
              stream: ref.stream,
              socket: tm.socket,
              token: tm.token,
              pane,
              pid,
            }),
            { mode: 0o600, flag: "wx" },
          );
        },
      );
      job.pane = start.pane;
      return {
        id: job.id,
        state: "running",
        launch: start.launch,
        logRef: ref,
        socket: tm.socket,
        attach: `tmux -S ${quote(tm.socket)} attach -t jobs`,
        note: "Watches are live-session only; logs contain untrusted, potentially sensitive output.",
      };
    } catch (error) {
      if (!this.jobsById.has(job.id)) {
        await this.storage.remove(ref).catch(() => {});
        throw error;
      }
      // startCaptured only rejects before the gate can release the user script.
      // A late sink cannot recreate a removed stream directory, so rollback is safe.
      await writeStopProof(dir, { version: 1, stream: ref.stream, state: "unstarted" }).catch(
        () => {},
      );
      const removed = await this.storage.remove(ref).then(
        () => true,
        () => false,
      );
      if (removed) {
        this.jobsById.delete(job.id);
        throw error;
      }
      job.failure = error instanceof Error ? error.message : String(error);
      return {
        id: job.id,
        state: "capture_failed",
        logRef: ref,
        error: `${job.failure}; startup rollback failed`,
        socket: tm.socket,
        attach: `tmux -S ${quote(tm.socket)} attach -t jobs`,
      };
    }
  }
  async jobs() {
    return Promise.all(
      [...this.jobsById.values()].map(async (j) => ({
        id: j.id,
        created: j.created,
        command: j.command,
        ...(await this.status(j)),
      })),
    );
  }
  private async read(ref: LogRef) {
    const dir = await this.storage.resolve(ref);
    const page = await readJournalTail(dir, ref.stream);
    const last = page.frames.at(-1);
    const end =
      page.health === "ready" && last?.sequence === page.tail
        ? completeUtf8Prefix(page.data, page.data.length)
        : page.data.length;
    let remaining = page.data.length - end;
    const pendingUtf8 = remaining > 0;
    let cursor = { sequence: page.tail, offset: 0 };
    for (let i = page.frames.length - 1; i >= 0 && remaining > 0; i--) {
      const f = page.frames[i];
      if (remaining < f.data.length) {
        cursor = { sequence: f.sequence, offset: f.data.length - remaining };
        remaining = 0;
      } else {
        remaining -= f.data.length;
        cursor = { sequence: f.sequence - 1, offset: 0 };
      }
    }
    const output = bounded(page.data.subarray(0, end).toString("utf8"));
    output.truncated ||= page.truncated;
    return {
      untrustedOutput: output,
      first: page.first,
      tail: page.tail,
      next: cursor,
      gap: page.gap,
      captureHealth: page.health,
      pendingUtf8,
    };
  }
  private async readForward(ref: LogRef, after: LogCursor) {
    if (
      !after ||
      !Number.isSafeInteger(after.sequence) ||
      after.sequence < 0 ||
      !Number.isSafeInteger(after.offset) ||
      after.offset < 0 ||
      after.offset > 16384 ||
      (!after.sequence && after.offset)
    )
      throw new Error("Invalid journal cursor");
    const dir = await this.storage.resolve(ref);
    const page = await readJournal(
      dir,
      ref.stream,
      after.offset ? after.sequence - 1 : after.sequence,
    );
    let skip = after.offset;
    if (skip && page.frames[0]?.sequence !== after.sequence) {
      if (!page.gap) throw new Error("Journal cursor does not identify a frame");
      skip = 0;
    }
    if (skip && skip >= page.frames[0].data.length) throw new Error("Invalid journal frame offset");
    const data = Buffer.concat(
      page.frames.map((f, i) => (i === 0 ? f.data.subarray(skip) : f.data)),
    );
    // Malformed bytes can expand to three-byte U+FFFD on UTF-8 rendering.
    let cut = Math.min(data.length, Math.floor(16384 / 3)),
      lines = 0;
    for (let i = 0; i < cut; i++) {
      if (data[i] === 10 && ++lines === 199) {
        cut = i + 1;
        break;
      }
    }
    while (cut > 0 && cut < data.length && (data[cut] & 0xc0) === 0x80) cut--;
    if (cut === 0 && data.length) cut = Math.min(data.length, Math.floor(16384 / 3));
    let pendingUtf8 = false;
    if (cut === data.length && (page.health === "ready" || page.next < page.tail)) {
      const complete = completeUtf8Prefix(data, cut);
      pendingUtf8 = complete < cut;
      cut = complete;
    }
    let consumed = cut;
    let cursor = page.gap
      ? { sequence: page.frames[0] ? page.frames[0].sequence - 1 : page.next, offset: 0 }
      : { ...after };
    for (let i = 0; i < page.frames.length && consumed > 0; i++) {
      const f = page.frames[i],
        start = i === 0 ? skip : 0,
        size = f.data.length - start;
      if (consumed < size) {
        cursor = { sequence: f.sequence, offset: start + consumed };
        consumed = 0;
      } else {
        cursor = { sequence: f.sequence, offset: 0 };
        consumed -= size;
      }
    }
    const more = (cut < data.length && !pendingUtf8) || page.next < page.tail;
    return {
      untrustedOutput: { text: sanitize(data.subarray(0, cut).toString("utf8")), truncated: more },
      first: page.first,
      tail: page.tail,
      next: cursor,
      gap: page.gap,
      captureHealth: page.health,
      pendingUtf8,
    };
  }
  async inspect(jobId: string, after?: LogCursor) {
    const job = this.find(jobId);
    return {
      id: job.id,
      ...(await this.status(job)),
      timestamp: new Date().toISOString(),
      ...(after ? await this.readForward(job.ref, after) : await this.read(job.ref)),
      logRef: job.ref,
    };
  }
  async inspectHistorical(ref: LogRef, after?: LogCursor) {
    const dir = await this.storage.resolve(ref);
    const proof = await readStopProof(dir, ref.stream).catch(() => undefined);
    return {
      historical: true,
      state: proof?.state ?? "unknown",
      ...(proof?.exitCode !== undefined ? { exitCode: proof.exitCode } : {}),
      ...(proof?.signal ? { signal: proof.signal } : {}),
      ...(after ? await this.readForward(ref, after) : await this.read(ref)),
      logRef: ref,
    };
  }
  async stop(jobId: string) {
    const job = this.find(jobId);
    const tm = this.tm;
    const current = await this.status(job);
    if (!["running", "capture_unverified"].includes(current.state))
      return { id: job.id, state: job.cancelled ? "cancelled" : "not-running" };
    if (
      !job.pane ||
      !job.pid ||
      !tm ||
      job.generation !== this.generation ||
      !(await this.verified())
    )
      throw new Error("Cannot verify producer before stopping");
    await tm.sourceOperation(job.pane, job.ref.stream, job.pid, "running", "interrupt");
    await new Promise((r) => setTimeout(r, 2000));
    const observed = await tm
      .sourceStatus(job.pane, job.ref.stream, job.pid)
      .catch(() => undefined);
    let confirmed = false;
    if (observed?.state === "running" || observed?.state === "exited") {
      await tm.sourceOperation(job.pane, job.ref.stream, job.pid, observed.state, "kill");
      confirmed = true;
      tm.cancelCaptureSupervisor(job.pane);
    } else if (observed?.state === "changed") {
      throw new Error("Producer identity changed; refusing to stop replacement");
    }
    if (!confirmed) await tm.waitCapture(job.pane).catch(() => {});
    const prior = await readStopProof(job.dir, job.ref.stream).catch(() => undefined);
    confirmed ||= !!prior && prior.state !== "unstarted";
    if (!confirmed)
      return {
        id: job.id,
        state: "capture_unverified",
        error: "Producer stop could not be verified",
      };
    job.cancelled = true;
    job.final = { state: "cancelled", capture: "draining" };
    const written = await withTimeout(
      writeStopProof(job.dir, {
        version: 1,
        stream: job.ref.stream,
        state: "cancelled",
        exitCode: observed?.state === "exited" ? observed.exitCode : prior?.exitCode,
        signal: observed?.state === "exited" ? observed.signal : prior?.signal,
      }),
      1000,
    ).then(
      () => true,
      () => false,
    );
    job.final.capture = await this.drainCapture(job, Date.now() + 5000);
    return {
      id: job.id,
      state: "cancelled",
      capture: job.final.capture,
      proofIncomplete: !written,
    };
  }
  private async reclaimDeadPane(ref: LogRef, dir: string) {
    const producer = JSON.parse(
      (await readPrivateFile(join(dir, "producer.json"), 4096)).toString("utf8"),
    );
    if (
      producer.version !== 1 ||
      producer.stream !== ref.stream ||
      typeof producer.socket !== "string" ||
      !/^\/tmp\/pbm-[A-Za-z0-9]{6}\/s$/.test(producer.socket) ||
      typeof producer.token !== "string" ||
      !/^[a-f0-9]{48}$/.test(producer.token) ||
      typeof producer.pane !== "string" ||
      !/^%\d+$/.test(producer.pane) ||
      !Number.isSafeInteger(producer.pid) ||
      producer.pid < 1
    )
      throw new Error("Invalid producer identity");
    const ownerDir = dirname(producer.socket);
    const owner = await lstat(ownerDir);
    const socket = await lstat(producer.socket);
    if (
      !owner.isDirectory() ||
      owner.isSymbolicLink() ||
      owner.uid !== process.getuid?.() ||
      owner.mode & 0o077 ||
      !socket.isSocket() ||
      socket.uid !== process.getuid?.()
    )
      throw new Error("Unsafe producer socket");
    const tm = new Tmux(producer.socket, ownerDir, producer.token);
    if (!(await tm.verify())) throw new Error("Producer server is unavailable");
    const status = await tm.sourceStatus(producer.pane, ref.stream, producer.pid);
    if (status.state !== "exited") throw new Error("Producer is not a verified dead pane");
    await tm.sourceOperation(producer.pane, ref.stream, producer.pid, "exited", "kill");
    await writeStopProof(dir, {
      version: 1,
      stream: ref.stream,
      state: "exited",
      exitCode: status.exitCode,
      signal: status.signal,
    });
  }
  private async verifyCaptureClosed(ref: LogRef, dir: string) {
    let proof = await readStopProof(dir, ref.stream).catch(() => undefined);
    if (!proof) {
      await this.reclaimDeadPane(ref, dir).catch(() => {
        throw new Error("Producer stop is unverified; cannot safely delete this source");
      });
      proof = await readStopProof(dir, ref.stream);
    }
    if (proof.state === "unstarted") return;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const metadata = await withTimeout(
        readPrivateFile(join(dir, "capture.json"), 4096),
        Math.max(1, deadline - Date.now()),
      ).catch(() => undefined);
      if (!metadata) break;
      const capture = JSON.parse(metadata.toString("utf8"));
      if (capture.version !== 1 || capture.stream !== ref.stream) break;
      if (["complete", "failed"].includes(capture.health)) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("Capture completion cannot be verified; refuse cleanup");
  }
  hasRef(ref: LogRef) {
    return [...this.jobsById.values()].some(
      (job) => job.ref.owner === ref.owner && job.ref.stream === ref.stream,
    );
  }
  async deleteHistorical(ref: LogRef) {
    const dir = await this.storage.resolve(ref);
    await this.verifyCaptureClosed(ref, dir);
    await this.storage.remove(ref);
    return { deleted: true };
  }
  async forget(jobId: string) {
    const job = this.find(jobId);
    const status = await this.status(job);
    if (status.state === "running") throw new Error("Cannot forget a running capture source");
    if (job.pane && job.generation === this.generation) await this.tm?.waitCapture(job.pane);
    await this.verifyCaptureClosed(job.ref, job.dir);
    await this.storage.remove(job.ref);
    this.jobsById.delete(job.id);
    this.tm?.forgetCaptureResult(job.dir);
    return { forgotten: jobId };
  }
  private async drainCapture(job: Job, deadline: number) {
    while (Date.now() < deadline) {
      try {
        const metadata = await withTimeout(
          readPrivateFile(join(job.dir, "capture.json"), 4096),
          Math.max(1, deadline - Date.now()),
        );
        const state = JSON.parse(metadata.toString("utf8"));
        if (state.version !== 1 || state.stream !== job.ref.stream) return "incomplete";
        if (state.health === "complete" || state.health === "failed") return state.health;
      } catch {
        return "incomplete";
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return "incomplete";
  }
  async serverStop() {
    if (!this.tm) return { stopped: false };
    const states = await Promise.all(
      [...this.jobsById.values()].map(async (job) => ({ job, status: await this.status(job) })),
    );
    const ownedServerStopped = await this.verified().catch(() => false);
    if (!ownedServerStopped)
      return {
        stopped: false,
        unverified: true,
        error: "Cannot verify the owned server; no stop was issued",
      };
    await checked(this.tm.args("kill-server"));
    this.tm.stopCaptureSupervisors();
    const proofWrites = await Promise.all(
      states.map(async ({ job, status }) => {
        if (!ownedServerStopped || !job.pane || job.generation !== this.generation) return true;
        const state =
          status.state === "exited"
            ? "exited"
            : status.state === "capture_failed"
              ? "capture_failed"
              : status.state === "running" ||
                  status.state === "capture_unverified" ||
                  status.state === "cancelled"
                ? "cancelled"
                : "lost";
        return withTimeout(
          writeStopProof(job.dir, {
            version: 1,
            stream: job.ref.stream,
            state,
            exitCode: status.exitCode,
            signal: status.signal,
          }),
          1000,
        ).then(
          () => true,
          () => false,
        );
      }),
    );
    const deadline = Date.now() + 5000;
    const captures = await Promise.all(
      states.map(({ job, status }) =>
        status.capture === "complete" || status.capture === "failed"
          ? status.capture
          : this.drainCapture(job, deadline),
      ),
    );
    for (let i = 0; i < states.length; i++) {
      const { job, status } = states[i];
      if (status.state === "running" || status.state === "capture_unverified") job.cancelled = true;
      job.final = {
        ...status,
        state: job.cancelled ? "cancelled" : status.state,
        capture: captures[i],
      };
    }
    const dir = this.dir;
    this.tm = undefined;
    this.dir = undefined;
    this.generation++;
    if (dir) await rm(dir, { recursive: true, force: true });
    return {
      stopped: true,
      logsRetained: true,
      incomplete: captures.filter((x) => x !== "complete").length,
      proofIncomplete: proofWrites.filter((ok) => !ok).length,
    };
  }
}
