import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { quote } from "./output.ts";
import {
  clearStopEvidence,
  getStopEvidence,
  rememberStopEvidence,
  type StopProof,
  writeStopEvidence,
} from "./proof.ts";

export type ClientResult = { code: number; stdout: string; stderr: string; truncated: boolean };
/** Drain both pipes even after reaching limits; never terminate the server for excess output. */
export function client(args: string[], timeout = 5000): Promise<ClientResult> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.TMUX;
    delete env.TMUX_PANE;
    const child = spawn("tmux", args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let out: Buffer<ArrayBufferLike>[] = [],
      err: Buffer<ArrayBufferLike>[] = [],
      outLen = 0,
      errLen = 0,
      truncated = false,
      timedOut = false;
    const collect = (chunk: Buffer, isErr: boolean) => {
      const len = isErr ? errLen : outLen;
      const keep = Math.max(0, 65536 - len);
      if (chunk.length > keep) truncated = true;
      if (isErr) {
        err.push(chunk.subarray(0, keep));
        errLen += Math.min(chunk.length, keep);
      } else {
        out.push(chunk.subarray(0, keep));
        outLen += Math.min(chunk.length, keep);
      }
    };
    child.stdout.on("data", (b: Buffer) => collect(b, false));
    child.stderr.on("data", (b: Buffer) => collect(b, true));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeout);
    timer.unref();
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error("tmux client timed out"));
      else
        resolve({
          code: code ?? -1,
          stdout: Buffer.concat(out).toString("utf8"),
          stderr: Buffer.concat(err).toString("utf8"),
          truncated,
        });
    });
  });
}
export async function checked(args: string[], timeout = 5000): Promise<ClientResult> {
  const r = await client(args, timeout);
  if (r.code !== 0) throw new Error(`tmux: ${r.stderr.trim() || `exit ${r.code}`}`);
  return r;
}
export async function probe(): Promise<void> {
  if (process.platform !== "linux" && process.platform !== "darwin")
    throw new Error("Only Linux and macOS are supported");
  let r: ClientResult;
  try {
    r = await checked(["-V"]);
  } catch {
    throw new Error("tmux >=3.2 is required; install tmux and ensure it is on PATH");
  }
  const v = /tmux (\d+)\.(\d+)/.exec(r.stdout);
  if (!v || Number(v[1]) < 3 || (Number(v[1]) === 3 && Number(v[2]) < 2))
    throw new Error("tmux >=3.2 is required");
}
export async function createDirectory(): Promise<{ dir: string; socket: string; token: string }> {
  const dir = await mkdtemp("/tmp/pbm-");
  await chmod(dir, 0o700);
  const socket = join(dir, "s"),
    token = randomBytes(24).toString("hex");
  if (Buffer.byteLength(socket) >= 90) throw new Error("tmux socket path too long");
  await writeFile(
    join(dir, "tmux.conf"),
    `set-option -g remain-on-exit on\nset-option -g history-limit 2000\nset-option -g default-shell /bin/bash\nset-option -g automatic-rename off\nset-option -g @pbm_owner ${token}\n`,
    { mode: 0o600, flag: "wx" },
  );
  return { dir, socket, token };
}
const ioKey = Symbol.for("pi-background-monitor:timed-io:v1");
const shared = globalThis as typeof globalThis & { [ioKey: symbol]: unknown };
if (!shared[ioKey]) shared[ioKey] = { active: 0 };
const timedIo = shared[ioKey] as { active: number };
export class IoCapacityError extends Error {
  constructor() {
    super("Timed IO capacity exhausted");
  }
}
/** Timed filesystem work remains charged until its uncancellable promise settles. */
export async function boundedIo<T>(fn: () => Promise<T>, timeout: number): Promise<T> {
  if (timedIo.active >= 16) throw new IoCapacityError();
  timedIo.active++;
  const operation = Promise.resolve().then(fn);
  void operation
    .finally(() => {
      timedIo.active--;
    })
    .catch(() => {});
  return withTimeout(operation, timeout);
}
export async function withTimeout<T>(operation: Promise<T>, timeout: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Capture operation timed out")),
          Math.max(1, timeout),
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
export class Tmux {
  private captureTimers = new Map<string, { timer: NodeJS.Timeout; cancelled: boolean }>();
  private captureResults = new Map<string, object>();
  private pendingReleases = new Set<string>();
  private detached = false;
  constructor(
    readonly socket: string,
    readonly dir: string,
    readonly token: string,
  ) {}
  args(...args: string[]) {
    return ["-S", this.socket, ...args];
  }
  async verify(timeout = 5000): Promise<boolean> {
    const r = await client(this.args("show-options", "-gv", "@pbm_owner"), timeout);
    if (r.code !== 0) {
      if (
        /no server running|error connecting to .*\(No such file or directory\)|error connecting to .*\(Connection refused\)/i.test(
          r.stderr,
        )
      )
        return false;
      throw new Error(`tmux owner verification failed: ${r.stderr.trim()}`);
    }
    if (r.stdout.trim() !== this.token) throw new Error("tmux owner mismatch; refusing operation");
    return true;
  }
  async start(script: string, cwd: string, first: boolean, timeout = 5000): Promise<string> {
    const args = first
      ? [
          "-f",
          join(this.dir, "tmux.conf"),
          "new-session",
          "-d",
          "-s",
          "jobs",
          "-n",
          "job",
          "-x",
          "80",
          "-y",
          "32",
          "-c",
          cwd,
          "-P",
          "-F",
          "#{pane_id}",
        ]
      : ["new-window", "-d", "-t", "jobs:", "-c", cwd, "-P", "-F", "#{pane_id}"];
    const r = await checked(
      this.args(...args, "/bin/bash", "--noprofile", "--norc", script),
      timeout,
    );
    const pane = r.stdout.trim();
    if (!/^%\d+$/.test(pane)) throw new Error("Unexpected tmux pane ID");
    return pane;
  }
  async releaseCaptureGate(path: string) {
    await writeFile(path, "", { mode: 0o600, flag: "wx" });
  }
  async launchMarker(path: string) {
    return stat(path);
  }
  private async cleanupGate(gate: string, knownPane?: string) {
    if (!(await this.verify().catch(() => false))) return;
    const listing = knownPane
      ? `${knownPane}|${gate}`
      : (await client(this.args("list-panes", "-a", "-F", "#{pane_id}|#{pane_start_command}")))
          .stdout;
    for (const row of listing.split("\n")) {
      const [pane, ...command] = row.split("|");
      if (!/^%\d+$/.test(pane) || !command.join("|").includes(gate)) continue;
      // Match the unique generated gate atomically at the server before killing.
      await client(
        this.args(
          "if-shell",
          "-F",
          "-t",
          pane,
          `#{m:*${gate}*,#{pane_start_command}}`,
          `kill-pane -t ${pane}`,
          "display-message -p gate-not-matched",
        ),
      ).catch(() => {});
    }
  }
  /** Install and verify the capture sink before allowing the user script to start. */
  async startCaptured(
    script: string,
    cwd: string,
    first: boolean,
    captureDir: string,
    runtime: string,
    stream?: string,
    onPane?: (pane: string, pid: number) => Promise<void>,
    canRelease?: () => boolean,
  ) {
    const nonce = randomBytes(24).toString("hex");
    const gate = join(this.dir, `${nonce}.gate`);
    const release = join(this.dir, `${nonce}.release`);
    const launched = join(this.dir, `${nonce}.launched`);
    const bridge = join(this.dir, `${nonce}.bridge`);
    const deadline = Date.now() + 5000;
    const remaining = () => {
      const ms = deadline - Date.now();
      if (ms <= 0) throw new Error("Capture startup timed out");
      return ms;
    };
    let pane: string | undefined;
    let released = false;
    let acknowledged = false;
    try {
      // A restarted tmux server can reuse pane IDs. Do not create it while an
      // earlier supervisor might still target the same ID during finalization.
      while (first && this.captureTimers.size && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 20));
      if (first && this.captureTimers.size) throw new Error("Previous capture is still finalizing");
      await writeFile(
        gate,
        `for ((i=0;i<1500;i++)); do\n  if [ -f ${quote(release)} ]; then\n    rm -f ${quote(gate)} ${quote(release)}\n    : > ${quote(launched)} || exit 125\n    exec /bin/bash --noprofile --norc ${quote(script)}\n  fi\n  sleep 0.02\ndone\nrm -f ${quote(gate)} ${quote(release)}\nexit 125\n`,
        { mode: 0o600, flag: "wx" },
      );
      await writeFile(
        bridge,
        `exec ${quote(process.execPath)} ${quote(runtime)} ${quote(captureDir)} ${quote(nonce)} ${quote(stream ?? nonce)}\n`,
        { mode: 0o600, flag: "wx" },
      );
      pane = await this.start(gate, cwd, first, remaining());
      if (!(await this.verify(remaining())))
        throw new Error("Server disappeared during capture startup");
      await checked(
        this.args("pipe-pane", "-O", "-t", pane, `/bin/bash ${quote(bridge)}`),
        remaining(),
      );
      let ready = false;
      while (Date.now() < deadline) {
        const metadata = await boundedIo(
          () => readFile(join(captureDir, "capture.json"), "utf8"),
          remaining(),
        ).catch(() => "");
        if (metadata) {
          const state = JSON.parse(metadata);
          if (state.nonce === nonce && state.health === "failed")
            throw new Error("Capture sink failed");
          if (state.nonce === nonce && state.health === "ready") {
            const pipe = await checked(
              this.args("display-message", "-p", "-t", pane, "#{pane_pipe}"),
              remaining(),
            );
            ready = pipe.stdout.trim() === "1";
            if (ready) break;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await checked(
        this.args("set-option", "-p", "-t", pane, "@pbm_stream", stream ?? nonce),
        remaining(),
      );
      const info = await checked(
        this.args("display-message", "-p", "-t", pane, "#{pane_pid}"),
        remaining(),
      );
      const pid = Number(info.stdout.trim());
      if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("Invalid producer PID");
      if (onPane) await onPane(pane, pid);
      const gateStatus = await this.sourceStatus(pane, stream ?? nonce, pid, remaining());
      if (!ready || Date.now() >= deadline || gateStatus.state !== "running")
        throw new Error("Capture sink or launcher did not become ready in time");
      this.superviseCapture(pane, captureDir, nonce, stream ?? nonce, pid);
      if (canRelease && !canRelease()) throw new Error("Session closed during startup");
      // Creating the release file may become visible even if the write rejects.
      released = true;
      this.pendingReleases.add(pane);
      try {
        await this.releaseCaptureGate(release);
      } finally {
        this.pendingReleases.delete(pane);
        if (this.detached) this.stopCaptureSupervisor(pane);
      }
      const ackDeadline = Date.now() + 5000;
      while (Date.now() < ackDeadline) {
        try {
          await boundedIo(
            () => this.launchMarker(launched),
            Math.min(200, ackDeadline - Date.now()),
          );
          acknowledged = true;
          break;
        } catch (error) {
          // Missing marker may appear later; a timeout or admission failure can
          // still be running physically and must not spawn replacement stats.
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      // After release the pane must remain tracked even if acknowledgement is missing.
      // The marker proves an exec attempt, not that the application itself ran.
      return { pane, launch: acknowledged ? ("confirmed" as const) : ("unknown" as const) };
    } catch (error) {
      // Release is a point of no return: never report failure and orphan a
      // possibly running command merely because its acknowledgement failed.
      if (released && pane) return { pane, launch: "unknown" as const };
      if (pane) this.stopCaptureSupervisor(pane);
      await this.cleanupGate(gate, pane);
      throw error;
    } finally {
      // Once released, cleanup must never turn a successful start into an untracked job.
      await rm(bridge, { force: true }).catch(() => {});
      if (!released) {
        await rm(gate, { force: true }).catch(() => {});
        await rm(release, { force: true }).catch(() => {});
      }
      if (!released || acknowledged) await rm(launched, { force: true }).catch(() => {});
    }
  }
  private stopCaptureSupervisor(pane: string) {
    const control = this.captureTimers.get(pane);
    if (control) {
      control.cancelled = true;
      clearInterval(control.timer);
    }
    this.captureTimers.delete(pane);
  }
  stopCaptureSupervisors() {
    this.detached = true;
    // A submitted release write may already have launched the job. Keep only
    // those supervisors until the actual write settles, without killing it.
    for (const pane of this.captureTimers.keys())
      if (!this.pendingReleases.has(pane)) this.stopCaptureSupervisor(pane);
  }
  cancelCaptureSupervisor(pane: string) {
    this.stopCaptureSupervisor(pane);
  }
  async waitCapture(pane: string) {
    const deadline = Date.now() + 5000;
    while (this.captureTimers.has(pane) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 20));
    if (this.captureTimers.has(pane)) throw new Error("Capture is still finalizing");
  }
  captureResult(dir: string) {
    return this.captureResults.get(dir);
  }
  forgetCaptureResult(dir: string) {
    this.captureResults.delete(dir);
  }
  private superviseCapture(pane: string, dir: string, nonce: string, stream: string, pid: number) {
    let busy = false;
    let finished = false;
    let unverifiedSince = 0;
    let knownExit: { state: "exited"; exitCode?: number; signal?: string } | undefined;
    let pendingProof: StopProof | undefined;
    const control = { timer: undefined as unknown as NodeJS.Timeout, cancelled: false };
    const finish = () => {
      clearInterval(control.timer);
      finished = true;
    };
    const finalize = (result: object) => {
      if (!control.cancelled)
        this.captureResults.set(dir, {
          ...result,
          ...(pendingProof ? { pendingProof } : {}),
          ...(pendingProof || getStopEvidence(dir)?.confirmed ? { proofIncomplete: true } : {}),
        });
    };
    const prove = async (
      state: StopProof["state"],
      status?: { exitCode?: number; signal?: string },
    ) => {
      if (control.cancelled) return;
      const proof: StopProof = { version: 1, stream, state, ...status };
      pendingProof = proof;
      try {
        const evidence = rememberStopEvidence(dir, proof, true);
        pendingProof = undefined; // Process-wide evidence owns retry after registration.
        await boundedIo(() => writeStopEvidence(dir, evidence), 1000);
        clearStopEvidence(dir, evidence);
        pendingProof = undefined;
      } catch {
        /* Retain evidence for an explicit retry while this controller lives. */
      }
    };
    const readState = async (timeout = 5000) =>
      JSON.parse(await boundedIo(() => readFile(join(dir, "capture.json"), "utf8"), timeout));
    const tick = async () => {
      if (busy) return;
      busy = true;
      let stopped = false;
      try {
        if (!(await this.verify())) throw new Error("Producer server unavailable");
        const status = await this.sourceStatus(pane, stream, pid);
        if (status.state === "changed" || status.state === "lost") {
          finish();
          await finalize({
            state: "lost",
            capture: "unknown",
            error: "Producer identity unavailable or changed",
          });
          return;
        }
        if (status.state === "exited") knownExit = status;
        const state = await readState();
        if (state.nonce !== nonce) throw new Error("Capture identity mismatch");
        if (status.state === "unverified") {
          // tmux may hide pane_pid after exit. EOF proves capture completion,
          // not the identity or exit status of the process now in the pane.
          unverifiedSince ||= Date.now();
          const complete = state.health === "complete";
          const done =
            complete || state.health === "failed" || Date.now() - unverifiedSince >= 5000;
          await finalize({
            state: "source_unverified",
            capture: complete ? "complete" : done ? "incomplete" : "draining",
            error: "Dead pane producer identity unavailable",
          });
          if (done) finish();
          return;
        }
        unverifiedSince = 0;
        if (status.state === "running") {
          const pipe = await checked(
            this.args("display-message", "-p", "-t", pane, "#{pane_pipe}"),
          );
          const heartbeat = await boundedIo(() => stat(join(dir, "heartbeat")), 5000);
          if (
            state.health !== "ready" ||
            pipe.stdout.trim() !== "1" ||
            Date.now() - heartbeat.mtimeMs > 5000
          ) {
            // Only the verified private server and its recorded pane are ever targeted.
            if (control.cancelled) return;
            await this.sourceOperation(pane, stream, pid, "running", "kill");
            if (control.cancelled) return;
            stopped = true;
            await prove("capture_failed");
            finish();
            await finalize({
              state: "capture_failed",
              capture: "failed",
              lastSinkHealth: state.health,
            });
          } else if (
            (this.captureResults.get(dir) as { state?: string } | undefined)?.state ===
            "capture_unverified"
          ) {
            this.captureResults.delete(dir);
          }
          return;
        }
        // tmux checks the dead state, stream and original PID atomically before
        // removing the pane, so a respawned replacement cannot be killed.
        await finalize({ ...status, capture: "draining" });
        if (control.cancelled) return;
        await this.sourceOperation(pane, stream, pid, "exited", "kill");
        if (control.cancelled) return;
        stopped = true;
        await prove("exited", { exitCode: status.exitCode, signal: status.signal });
        finish();
        const deadline = Date.now() + 5000;
        let health = state.health;
        while (health === "ready" && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          health = (await readState(Math.max(1, deadline - Date.now()))).health;
        }
        await finalize({ ...status, capture: health === "complete" ? "complete" : "incomplete" });
      } catch (error) {
        if (control.cancelled) return;
        if (error instanceof IoCapacityError) {
          await finalize({ state: "capture_unverified", capture: "unknown", error: error.message });
          return;
        }
        let killed = stopped;
        if (!killed && !control.cancelled) {
          try {
            await this.sourceOperation(pane, stream, pid, knownExit ? "exited" : "either", "kill");
            if (control.cancelled) return;
            killed = true;
          } catch {
            /* A changed/unavailable source is never targeted without proof. */
          }
        }
        if (killed) {
          finish();
          if (knownExit)
            await prove("exited", { exitCode: knownExit.exitCode, signal: knownExit.signal });
          else await prove("capture_failed");
          await finalize({
            ...(knownExit ?? { state: "capture_failed" }),
            capture: "incomplete",
            error: String(error).slice(0, 512),
          });
        } else {
          await finalize({
            state: "capture_unverified",
            capture: "unknown",
            error: String(error).slice(0, 512),
          });
        }
      } finally {
        busy = false;
        if (finished && this.captureTimers.get(pane) === control) this.captureTimers.delete(pane);
      }
    };
    control.timer = setInterval(() => {
      void tick();
    }, 250);
    control.timer.unref();
    this.captureTimers.set(pane, control);
  }
  private sourceCondition(
    pane: string,
    stream: string,
    pid: number,
    expected: "running" | "exited" | "either",
  ) {
    if (
      !/^%\d+$/.test(pane) ||
      !/^(?:[a-f0-9]{24}|[a-f0-9]{48})$/.test(stream) ||
      !Number.isSafeInteger(pid) ||
      pid < 1
    )
      throw new Error("Invalid source identity");
    const identity = `#{&&:#{==:#{@pbm_stream},${stream}},#{==:#{pane_pid},${pid}}}`;
    return expected === "either"
      ? identity
      : `#{&&:${identity},#{==:#{pane_dead},${expected === "exited" ? 1 : 0}}}`;
  }
  async sourceStatus(pane: string, stream: string, pid: number, timeout = 5000) {
    this.sourceCondition(pane, stream, pid, "either");
    const r = await client(
      this.args(
        "display-message",
        "-p",
        "-t",
        pane,
        "#{pane_dead}|#{pane_pid}|#{@pbm_stream}|#{pane_dead_status}|#{pane_dead_signal}",
      ),
      timeout,
    );
    if (r.code) {
      const panes = await checked(this.args("list-panes", "-a", "-F", "#{pane_id}"), timeout);
      if (!panes.stdout.trim().split("\n").includes(pane)) return { state: "lost" as const };
      throw new Error("Unable to inspect producer pane");
    }
    const [dead, actualPid, actualStream, status, signal] = r.stdout.trim().split("|");
    if (actualStream !== stream) return { state: "changed" as const };
    if (dead === "1" && actualPid === "") return { state: "unverified" as const };
    if (actualPid !== String(pid)) return { state: "changed" as const };
    if (dead === "1")
      return {
        state: "exited" as const,
        exitCode: /^\d+$/.test(status) ? Number(status) : undefined,
        signal: signal || undefined,
      };
    if (dead === "0") return { state: "running" as const };
    throw new Error("Unknown producer state");
  }
  async sourceOperation(
    pane: string,
    stream: string,
    pid: number,
    expected: "running" | "exited" | "either",
    operation: "kill" | "interrupt",
    active = () => true,
  ) {
    const condition = this.sourceCondition(pane, stream, pid, expected);
    if (!(await this.verify())) throw new Error("Producer server unavailable");
    if (!active()) throw new Error("Session closed before producer control");
    const action = operation === "kill" ? `kill-pane -t ${pane}` : `send-keys -t ${pane} C-c`;
    const result = await checked(
      this.args(
        "if-shell",
        "-F",
        "-t",
        pane,
        condition,
        action,
        "display-message -p pbm-source-mismatch",
      ),
    );
    if (result.stdout.includes("pbm-source-mismatch"))
      throw new Error("Producer identity or state changed");
  }
  async status(pane: string, timeout = 5000) {
    const r = await client(
      this.args(
        "display-message",
        "-p",
        "-t",
        pane,
        "#{pane_dead}|#{pane_dead_status}|#{pane_dead_signal}",
      ),
      timeout,
    );
    if (r.code) return { state: "lost" as const };
    const [dead, status, signal] = r.stdout.trim().split("|");
    return dead === "1"
      ? {
          state: "exited" as const,
          exitCode: /^\d+$/.test(status) ? Number(status) : undefined,
          signal: signal || undefined,
        }
      : dead === "0"
        ? { state: "running" as const }
        : { state: "lost" as const };
  }
}
