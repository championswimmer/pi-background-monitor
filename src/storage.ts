import { randomBytes } from "node:crypto";
import { lstat, mkdir, rm, rmdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { readPrivateFile } from "./journal.ts";

const identity = () => randomBytes(12).toString("hex");
const validIdentity = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{24}$/.test(value);
export type LogRef = { version: 1; session: string; owner: string; stream: string; slot: number };

async function privateDirectory(path: string, create = false) {
  if (create)
    await mkdir(path, { mode: 0o700 }).catch((e) => {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    });
  const s = await lstat(path);
  if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid?.() || s.mode & 0o077)
    throw new Error("Unsafe background log directory");
}
export function stateRoot() {
  const xdg = process.env.XDG_STATE_HOME;
  const base = xdg && isAbsolute(xdg) ? xdg : join(homedir(), ".local", "state");
  return join(base, "pi-background-monitor");
}
export class LogStorage {
  readonly owner = identity();
  constructor(
    readonly session: string,
    readonly root = stateRoot(),
  ) {
    if (!session || session.length > 512) throw new Error("Invalid session identity");
    if (!isAbsolute(root)) throw new Error("Log root must be absolute");
  }
  async prepare() {
    await mkdir(join(this.root, ".."), { recursive: true, mode: 0o700 });
    await privateDirectory(this.root, true);
    await privateDirectory(join(this.root, "owners"), true);
    await privateDirectory(join(this.root, "slots"), true);
  }
  async reserve() {
    await this.prepare();
    const owners = join(this.root, "owners");
    const ownerPath = join(owners, this.owner);
    let slot = -1;
    for (let i = 0; i < 128; i++) {
      try {
        await mkdir(join(this.root, "slots", String(i)), { mode: 0o700 });
        slot = i;
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
    }
    if (slot < 0) throw new Error("Log storage is full; explicitly delete retained logs first");
    const ref: LogRef = {
      version: 1,
      session: this.session,
      owner: this.owner,
      stream: identity(),
      slot,
    };
    const dir = join(ownerPath, ref.stream);
    let created = false;
    try {
      await privateDirectory(ownerPath, true);
      await mkdir(dir, { mode: 0o700 });
      created = true;
      const info = JSON.stringify(ref);
      await writeFile(join(dir, "log.json"), info, { mode: 0o600, flag: "wx" });
      await writeFile(join(this.root, "slots", String(slot), "reservation.json"), info, {
        mode: 0o600,
        flag: "wx",
      });
      return { ref, dir };
    } catch (e) {
      if (created) await rm(dir, { recursive: true, force: true });
      await rmdir(ownerPath).catch(() => {});
      await rm(join(this.root, "slots", String(slot)), { recursive: true, force: true });
      throw e;
    }
  }
  async resolve(value: unknown) {
    const ref = value as LogRef;
    if (
      !ref ||
      ref.version !== 1 ||
      ref.session !== this.session ||
      !validIdentity(ref.owner) ||
      !validIdentity(ref.stream) ||
      !Number.isInteger(ref.slot) ||
      ref.slot < 0 ||
      ref.slot >= 128
    )
      throw new Error("Invalid log reference");
    await privateDirectory(this.root);
    await privateDirectory(join(this.root, "owners"));
    await privateDirectory(join(this.root, "slots"));
    await privateDirectory(join(this.root, "owners", ref.owner));
    const dir = join(this.root, "owners", ref.owner, ref.stream);
    await privateDirectory(dir);
    const slot = join(this.root, "slots", String(ref.slot));
    await privateDirectory(slot);
    const log = JSON.parse((await readPrivateFile(join(dir, "log.json"), 4096)).toString("utf8"));
    const reservation = JSON.parse(
      (await readPrivateFile(join(slot, "reservation.json"), 4096)).toString("utf8"),
    );
    for (const item of [log, reservation]) {
      if (
        item.version !== 1 ||
        item.session !== ref.session ||
        item.owner !== ref.owner ||
        item.stream !== ref.stream ||
        item.slot !== ref.slot
      )
        throw new Error("Log reference does not match reservation");
    }
    return dir;
  }
  async remove(ref: LogRef, active = () => true) {
    const dir = await this.resolve(ref);
    if (!active()) throw new Error("Session closed before log deletion");
    // Once removal begins, finish both directory and reservation cleanup.
    await rm(dir, { recursive: true });
    await rm(join(this.root, "slots", String(ref.slot)), { recursive: true });
    await rmdir(join(this.root, "owners", ref.owner)).catch(() => {});
  }
}
