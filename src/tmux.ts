import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { quote } from "./output.ts";

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
async function withTimeout<T>(operation: Promise<T>, timeout: number): Promise<T> {
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
  /** Install and verify the capture sink before allowing the user script to start. */
  async startCaptured(
    script: string,
    cwd: string,
    first: boolean,
    captureDir: string,
    runtime: string,
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
      await writeFile(
        gate,
        `for ((i=0;i<1500;i++)); do\n  if [ -f ${quote(release)} ]; then\n    rm -f ${quote(gate)} ${quote(release)}\n    : > ${quote(launched)} || exit 125\n    exec /bin/bash --noprofile --norc ${quote(script)}\n  fi\n  sleep 0.02\ndone\nrm -f ${quote(gate)} ${quote(release)}\nexit 125\n`,
        { mode: 0o600, flag: "wx" },
      );
      await writeFile(
        bridge,
        `exec ${quote(process.execPath)} ${quote(runtime)} ${quote(captureDir)} ${quote(nonce)} ${quote(nonce)}\n`,
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
        const metadata = await withTimeout(
          readFile(join(captureDir, "capture.json"), "utf8"),
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
      const gateStatus = await this.status(pane, remaining());
      if (!ready || Date.now() >= deadline || gateStatus.state !== "running")
        throw new Error("Capture sink or launcher did not become ready in time");
      this.superviseCapture(pane, captureDir, nonce);
      // Creating the release file may become visible even if the write rejects.
      released = true;
      await this.releaseCaptureGate(release);
      const ackDeadline = Date.now() + 5000;
      while (Date.now() < ackDeadline) {
        if (
          await withTimeout(stat(launched), Math.min(200, ackDeadline - Date.now())).then(
            () => true,
            () => false,
          )
        ) {
          acknowledged = true;
          break;
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
      if (pane && (await this.verify().catch(() => false)))
        await client(this.args("kill-pane", "-t", pane));
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
    for (const pane of this.captureTimers.keys()) this.stopCaptureSupervisor(pane);
  }
  captureResult(pane: string) {
    return this.captureResults.get(pane);
  }
  forgetCaptureResult(pane: string) {
    this.captureResults.delete(pane);
  }
  private superviseCapture(pane: string, dir: string, nonce: string) {
    let busy = false;
    let finished = false;
    let publicationFailed = false;
    let knownExit: { state: "exited"; exitCode?: number; signal?: string } | undefined;
    const control = { timer: undefined as unknown as NodeJS.Timeout, cancelled: false };
    const finish = () => {
      clearInterval(control.timer);
      finished = true;
    };
    const finalize = async (result: object) => {
      if (control.cancelled) return;
      this.captureResults.set(pane, result);
      if (publicationFailed) return;
      const tmp = join(dir, "final.tmp");
      try {
        await withTimeout(writeFile(tmp, JSON.stringify(result), { mode: 0o600 }), 1000);
        await withTimeout(rename(tmp, join(dir, "final.json")), 1000);
      } catch {
        // A timed-out rename can still finish later; never publish a newer result to
        // disk afterward, but keep the authentic status in the live process.
        publicationFailed = true;
      }
    };
    const readState = async (timeout = 5000) =>
      JSON.parse(await withTimeout(readFile(join(dir, "capture.json"), "utf8"), timeout));
    const tick = async () => {
      if (busy) return;
      busy = true;
      try {
        if (!(await this.verify())) {
          finish();
          await finalize({ state: "lost", capture: "unknown" });
          return;
        }
        const status = await this.status(pane);
        if (status.state === "exited") knownExit = status;
        const state = await readState();
        if (state.nonce !== nonce) throw new Error("Capture identity mismatch");
        if (status.state === "running") {
          const pipe = await checked(
            this.args("display-message", "-p", "-t", pane, "#{pane_pipe}"),
          );
          const heartbeat = await withTimeout(stat(join(dir, "heartbeat")), 5000);
          if (
            state.health !== "ready" ||
            pipe.stdout.trim() !== "1" ||
            Date.now() - heartbeat.mtimeMs > 5000
          ) {
            // Only the verified private server and its recorded pane are ever targeted.
            if (control.cancelled) return;
            await checked(this.args("kill-pane", "-t", pane));
            finish();
            await finalize({
              state: "capture_failed",
              capture: "failed",
              lastSinkHealth: state.health,
            });
          }
          return;
        }
        finish();
        if (status.state === "lost") {
          await finalize({ state: "lost", capture: "unknown" });
          return;
        }
        // Dead retained panes keep their pipe open; remove the owned pane only after
        // recording its status, then wait boundedly for the sink to drain and close.
        await finalize({ ...status, capture: "draining" });
        if (control.cancelled) return;
        await checked(this.args("kill-pane", "-t", pane));
        const deadline = Date.now() + 5000;
        let health = state.health;
        while (health === "ready" && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          health = (await readState(Math.max(1, deadline - Date.now()))).health;
        }
        await finalize({ ...status, capture: health === "complete" ? "complete" : "incomplete" });
      } catch (error) {
        finish();
        // Re-verify ownership before fail-stop even when inspection failed.
        if ((await this.verify().catch(() => false)) && !control.cancelled)
          await client(this.args("kill-pane", "-t", pane)).catch(() => {});
        await finalize({
          ...(knownExit ?? { state: "capture_failed" }),
          capture: "incomplete",
          error: String(error).slice(0, 512),
        });
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
  async capture(pane: string) {
    const r = await checked(this.args("capture-pane", "-p", "-t", pane, "-S", "-200"));
    return r;
  }
}
