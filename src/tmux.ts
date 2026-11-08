import { spawn } from "node:child_process";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

export type ClientResult = { code: number; stdout: string; stderr: string; truncated: boolean };
/** Drain both pipes even after reaching limits; never terminate the server for excess output. */
export function client(args: string[], timeout = 5000): Promise<ClientResult> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env }; delete env.TMUX; delete env.TMUX_PANE;
    const child = spawn("tmux", args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let out: Buffer<ArrayBufferLike>[] = [], err: Buffer<ArrayBufferLike>[] = [], outLen = 0, errLen = 0, truncated = false, timedOut = false;
    const collect = (chunk: Buffer, isErr: boolean) => {
      const len = isErr ? errLen : outLen; const keep = Math.max(0, 65536 - len);
      if (chunk.length > keep) truncated = true;
      if (isErr) { err.push(chunk.subarray(0, keep)); errLen += Math.min(chunk.length, keep); }
      else { out.push(chunk.subarray(0, keep)); outLen += Math.min(chunk.length, keep); }
    };
    child.stdout.on("data", (b: Buffer) => collect(b, false)); child.stderr.on("data", (b: Buffer) => collect(b, true));
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeout); timer.unref();
    child.on("error", e => { clearTimeout(timer); reject(e); });
    child.on("close", code => { clearTimeout(timer); if (timedOut) reject(new Error("tmux client timed out")); else resolve({ code: code ?? -1, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), truncated }); });
  });
}
export async function checked(args: string[]): Promise<ClientResult> {
  const r = await client(args); if (r.code !== 0) throw new Error(`tmux: ${r.stderr.trim() || `exit ${r.code}`}`); return r;
}
export async function probe(): Promise<void> {
  if (process.platform !== "linux" && process.platform !== "darwin") throw new Error("Only Linux and macOS are supported");
  let r: ClientResult; try { r = await checked(["-V"]); } catch { throw new Error("tmux >=3.2 is required; install tmux and ensure it is on PATH"); }
  const v = /tmux (\d+)\.(\d+)/.exec(r.stdout); if (!v || Number(v[1]) < 3 || (Number(v[1]) === 3 && Number(v[2]) < 2)) throw new Error("tmux >=3.2 is required");
}
export async function createDirectory(): Promise<{ dir: string; socket: string; token: string }> {
  const dir = await mkdtemp("/tmp/pbm-"); await chmod(dir, 0o700);
  const socket = join(dir, "s"), token = randomBytes(24).toString("hex");
  if (Buffer.byteLength(socket) >= 90) throw new Error("tmux socket path too long");
  await writeFile(join(dir, "tmux.conf"), `set-option -g remain-on-exit on\nset-option -g history-limit 2000\nset-option -g default-shell /bin/bash\nset-option -g automatic-rename off\nset-option -g @pbm_owner ${token}\n`, { mode: 0o600, flag: "wx" });
  return { dir, socket, token };
}
export class Tmux {
  constructor(readonly socket: string, readonly dir: string, readonly token: string) {}
  args(...args: string[]) { return ["-S", this.socket, ...args]; }
  async verify(): Promise<boolean> { const r = await client(this.args("show-options", "-gv", "@pbm_owner")); if (r.code !== 0) { if (/no server running|error connecting to .*\(No such file or directory\)|error connecting to .*\(Connection refused\)/i.test(r.stderr)) return false; throw new Error(`tmux owner verification failed: ${r.stderr.trim()}`); } if (r.stdout.trim() !== this.token) throw new Error("tmux owner mismatch; refusing operation"); return true; }
  async start(script: string, cwd: string, first: boolean): Promise<string> {
    const args = first ? ["-f", join(this.dir, "tmux.conf"), "new-session", "-d", "-s", "jobs", "-n", "job", "-x", "120", "-y", "40", "-c", cwd, "-P", "-F", "#{pane_id}"] : ["new-window", "-d", "-t", "jobs:", "-c", cwd, "-P", "-F", "#{pane_id}"];
    const r = await checked(this.args(...args, "/bin/bash", "--noprofile", "--norc", script));
    const pane = r.stdout.trim(); if (!/^%\d+$/.test(pane)) throw new Error("Unexpected tmux pane ID"); return pane;
  }
  async status(pane: string) { const r = await client(this.args("display-message", "-p", "-t", pane, "#{pane_dead}|#{pane_dead_status}|#{pane_dead_signal}")); if (r.code) return { state: "lost" as const }; const [dead, status, signal] = r.stdout.trim().split("|"); return dead === "1" ? { state: "exited" as const, exitCode: /^\d+$/.test(status) ? Number(status) : undefined, signal: signal || undefined } : dead === "0" ? { state: "running" as const } : { state: "lost" as const }; }
  async capture(pane: string) { const r = await checked(this.args("capture-pane", "-p", "-t", pane, "-S", "-200")); return r; }
}
