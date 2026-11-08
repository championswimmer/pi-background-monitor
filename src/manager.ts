import { randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { bounded, quote, sanitize } from "./output.ts";
import { checked, client, createDirectory, probe, Tmux } from "./tmux.ts";

type Job = {
  id: string;
  pane?: string;
  created: string;
  command?: string;
  cancelled?: boolean;
  finalOutput?: { text: string; truncated: boolean };
};
type Locator = { session: string; dir: string; token: string };
type Registry = Locator & { version: 1; jobs: Job[] };
const id = () => randomBytes(12).toString("hex");
export const validId = (x: unknown): x is string =>
  typeof x === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(x);
function validLocator(x: Locator, session: string): boolean {
  return (
    !!x &&
    x.session === session &&
    typeof x.dir === "string" &&
    /^\/tmp\/pbm-[A-Za-z0-9]{6}$/.test(x.dir) &&
    typeof x.token === "string" &&
    /^[a-f0-9]{48}$/.test(x.token)
  );
}
export class Manager {
  private data?: Registry;
  private tm?: Tmux;
  private locked = false;
  private closed = false;
  private pending: Promise<unknown> = Promise.resolve();
  constructor(
    readonly session: string,
    readonly locate: () => unknown,
    readonly persist: (x: Locator | null) => void,
  ) {}
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
    if (this.locked && this.data) {
      await rm(join(this.data.dir, "lock"), { recursive: true, force: true });
      this.locked = false;
    }
  }
  private async acquire(dir: string) {
    try {
      await mkdir(join(dir, "lock"), { mode: 0o700 });
      this.locked = true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST")
        throw new Error(
          `Controller lock exists: ${dir}/lock. If no Pi process uses this session, remove it manually.`,
        );
      throw e;
    }
  }
  private async directoryExists(dir: string): Promise<boolean> {
    try {
      const ds = await lstat(dir);
      if (
        !ds.isDirectory() ||
        ds.isSymbolicLink() ||
        ds.uid !== process.getuid?.() ||
        (ds.mode & 0o077) !== 0
      )
        throw new Error("Unsafe background directory");
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw e;
    }
  }
  private async load(create: boolean) {
    if (this.data) {
      if (await this.directoryExists(this.data.dir)) return;
      this.data = undefined;
      this.tm = undefined;
      this.locked = false;
      this.persist(null);
    }
    let locator = this.locate() as Locator | null | undefined;
    if (locator) {
      if (!validLocator(locator, this.session))
        throw new Error("Invalid background server locator; refusing recovery");
      if (!(await this.directoryExists(locator.dir))) {
        this.persist(null);
        locator = null;
      }
    }
    if (!locator) {
      if (!create) return;
      await probe();
      const d = await createDirectory();
      await this.acquire(d.dir);
      this.data = { version: 1, session: this.session, dir: d.dir, token: d.token, jobs: [] };
      this.tm = new Tmux(d.socket, d.dir, d.token);
      await this.save();
      this.persist({ session: this.session, dir: d.dir, token: d.token });
      return;
    }
    await this.acquire(locator.dir);
    try {
      const path = join(locator.dir, "registry.json"),
        s = await lstat(path);
      if (
        !s.isFile() ||
        s.isSymbolicLink() ||
        s.size > 262144 ||
        s.uid !== process.getuid?.() ||
        s.mode & 0o077
      )
        throw new Error("Unsafe registry");
      const data = JSON.parse(await readFile(path, "utf8")) as Registry;
      if (
        data.version !== 1 ||
        !validLocator(data, this.session) ||
        data.dir !== locator.dir ||
        data.token !== locator.token ||
        !Array.isArray(data.jobs) ||
        data.jobs.length > 8 ||
        new Set(data.jobs.map((j) => (typeof j.id === "string" ? j.id.toLowerCase() : j.id)))
          .size !== data.jobs.length ||
        data.jobs.some(
          (j) =>
            !validId(j.id) ||
            (j.command !== undefined &&
              (typeof j.command !== "string" || j.command.length > 512)) ||
            (j.pane !== undefined && !/^%\d+$/.test(j.pane)) ||
            (j.finalOutput !== undefined &&
              (typeof j.finalOutput.text !== "string" ||
                Buffer.byteLength(j.finalOutput.text) > 16384 ||
                typeof j.finalOutput.truncated !== "boolean")),
        )
      )
        throw new Error("Invalid registry");
      this.data = data;
      this.tm = new Tmux(join(data.dir, "s"), data.dir, data.token);
      const socket = await lstat(this.tm.socket).catch(() => undefined);
      if (socket) {
        if (!socket.isSocket() || socket.uid !== process.getuid?.())
          throw new Error("Unsafe tmux socket");
        await this.tm.verify();
      }
    } catch (e) {
      this.data = undefined;
      this.tm = undefined;
      await rm(join(locator.dir, "lock"), { recursive: true, force: true });
      this.locked = false;
      throw e;
    }
  }
  private async save() {
    if (!this.data) throw new Error("No registry");
    const path = join(this.data.dir, "registry.json"),
      tmp = `${path}.${id()}`;
    await writeFile(tmp, JSON.stringify(this.data), { mode: 0o600, flag: "wx" });
    await rename(tmp, path);
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
    const j = this.data?.jobs.find((x) => x.id === jobId);
    if (!j) throw new Error("Unknown job");
    return j;
  }
  async start(command: string, cwd: string, requestedId?: string) {
    if (requestedId !== undefined && !validId(requestedId)) throw new Error("Invalid job ID");
    if (typeof command !== "string" || !command.trim() || Buffer.byteLength(command) > 65536)
      throw new Error("Command must be 1–65536 bytes");
    if (!(await stat(cwd)).isDirectory()) throw new Error("cwd is not a directory");
    await this.load(true);
    const d = this.data!,
      tm = this.tm!;
    if (d.jobs.length >= 8) throw new Error("Maximum 8 retained jobs; forget a finished job first");
    const jobId = requestedId ?? id();
    if (d.jobs.some((job) => job.id.toLowerCase() === jobId.toLowerCase()))
      throw new Error("Duplicate monitor identity (case-insensitive within a server)");
    const exists = await this.verified();
    if (!exists && d.jobs.length)
      throw new Error(
        "Server is missing; jobs lost. Stop the server record before starting again.",
      );
    const job: Job = {
      id: jobId,
      created: new Date().toISOString(),
      command: sanitize(command).replace(/\s+/g, " ").slice(0, 512),
    };
    const script = join(d.dir, `${job.id}.sh`);
    await writeFile(script, command, { mode: 0o600, flag: "wx" });
    d.jobs.push(job);
    await this.save();
    try {
      job.pane = await tm.start(script, cwd, !exists);
      if (!(await tm.verify())) throw new Error("Server disappeared during startup");
      await this.save();
    } catch (e) {
      if (job.pane && (await this.verified().catch(() => false)))
        await client(tm.args("kill-pane", "-t", job.pane));
      d.jobs = d.jobs.filter((x) => x !== job);
      await this.save();
      await unlink(script).catch(() => {});
      throw e;
    }
    return {
      id: job.id,
      state: "running",
      socket: tm.socket,
      attach: `tmux -S ${quote(tm.socket)} attach -t jobs`,
      note: "Job survives Pi shutdown; explicitly stop it or the server.",
    };
  }
  async jobs() {
    await this.load(false);
    if (!this.data) return [];
    const available = await this.verified();
    return Promise.all(
      this.data.jobs.map(async (j) => ({
        id: j.id,
        created: j.created,
        command: j.command,
        ...(j.cancelled
          ? { state: "cancelled" }
          : available && j.pane
            ? await this.tm!.status(j.pane)
            : { state: "lost" }),
      })),
    );
  }
  async inspect(jobId: string) {
    await this.load(false);
    const j = this.find(jobId);
    if (j.cancelled)
      return {
        id: j.id,
        state: "cancelled",
        timestamp: new Date().toISOString(),
        untrustedOutput: j.finalOutput ?? { text: "", truncated: false },
        clientTruncated: false,
      };
    if (!j.pane || !(await this.verified())) return { id: j.id, state: "lost" };
    const status = await this.tm!.status(j.pane);
    if (status.state === "lost") return { id: j.id, ...status };
    try {
      const r = await this.tm!.capture(j.pane);
      return {
        id: j.id,
        ...status,
        timestamp: new Date().toISOString(),
        untrustedOutput: bounded(r.stdout),
        clientTruncated: r.truncated,
      };
    } catch (e) {
      if ((await this.tm!.status(j.pane)).state === "lost") return { id: j.id, state: "lost" };
      throw e;
    }
  }
  async stop(jobId: string) {
    await this.load(false);
    const j = this.find(jobId);
    if (j.pane && (await this.verified()) && (await this.tm!.status(j.pane)).state === "running") {
      try {
        j.finalOutput = bounded((await this.tm!.capture(j.pane)).stdout);
      } catch {
        /* pane may exit during cancellation */
      }
      await checked(this.tm!.args("send-keys", "-t", j.pane, "C-c"));
      await new Promise((r) => setTimeout(r, 2000));
      if ((await this.tm!.status(j.pane)).state === "running")
        await client(this.tm!.args("kill-pane", "-t", j.pane));
      j.cancelled = true;
      await this.save();
    }
    return { id: j.id, state: j.cancelled ? "cancelled" : "not-running" };
  }
  async forget(jobId: string) {
    await this.load(false);
    const j = this.find(jobId);
    if (j.pane && (await this.verified())) {
      if ((await this.tm!.status(j.pane)).state === "running")
        throw new Error("Stop running job before forgetting it");
      await client(this.tm!.args("kill-pane", "-t", j.pane));
    }
    this.data!.jobs = this.data!.jobs.filter((x) => x !== j);
    await this.save();
    await unlink(join(this.data!.dir, `${j.id}.sh`)).catch(() => {});
    return { forgotten: jobId };
  }
  async serverStop() {
    await this.load(false);
    if (!this.data) return { stopped: false };
    if (await this.verified()) await checked(this.tm!.args("kill-server"));
    const dir = this.data.dir;
    this.data = undefined;
    this.tm = undefined;
    this.locked = false;
    await rm(dir, { recursive: true, force: true });
    this.persist(null);
    return { stopped: true };
  }
}
