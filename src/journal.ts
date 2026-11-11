import { constants } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { join } from "node:path";

export type Frame = { sequence: number; start: number; end: number; data: Buffer };
type State = { version: number; stream: string; first: number; tail: number; health: string };
const MAX_SEGMENT = 1024 * 1024;
export async function readPrivateFile(path: string, limit: number) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.uid !== process.getuid?.() || info.mode & 0o077 || info.size > limit)
      throw new Error("Unsafe or oversized journal file");
    const data = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < data.length) {
      const read = await file.read(data, size, data.length - size, null);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    if (size > limit) throw new Error("Oversized journal file");
    return data.subarray(0, size);
  } finally {
    await file.close();
  }
}
function integer(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
async function state(dir: string, stream: string): Promise<State> {
  const s = JSON.parse(
    (await readPrivateFile(join(dir, "capture.json"), 4096)).toString(),
  ) as State;
  if (
    s.version !== 1 ||
    s.stream !== stream ||
    !integer(s.first) ||
    s.first < 1 ||
    !integer(s.tail) ||
    s.first > s.tail + 1 ||
    !["ready", "complete", "failed"].includes(s.health)
  )
    throw new Error("Invalid capture metadata");
  return s;
}
function frame(line: string, stream: string): Frame {
  const f = JSON.parse(line);
  if (
    f.version !== 1 ||
    f.stream !== stream ||
    f.kind !== "output" ||
    !integer(f.sequence) ||
    f.sequence < 1 ||
    !integer(f.start) ||
    !integer(f.end) ||
    f.end < f.start ||
    typeof f.data !== "string" ||
    f.data.length > 21848
  )
    throw new Error("Invalid journal frame");
  const data = Buffer.from(f.data, "base64");
  if (data.length > 16384 || data.length !== f.end - f.start || data.toString("base64") !== f.data)
    throw new Error("Invalid journal payload");
  return { sequence: f.sequence, start: f.start, end: f.end, data };
}
export async function readJournal(
  dir: string,
  stream: string,
  after = 0,
  maxBytes = 256 * 1024,
  maxFrames = 200,
) {
  if (!integer(after)) throw new Error("Invalid journal cursor");
  const metadata = await state(dir, stream);
  if (after > metadata.tail) throw new Error("Journal cursor is beyond the published tail");
  if (!integer(maxBytes) || maxBytes < 16384 || !integer(maxFrames) || maxFrames < 1)
    throw new Error("Invalid journal read limit");
  let next = Math.max(after, metadata.first - 1);
  let gap = after < metadata.first - 1;
  let limited = false;
  let previousEnd: number | undefined;
  let bytes = 0;
  const frames: Frame[] = [];
  const names = (await readdir(dir))
    .filter((n) => /^(?:0|[1-9]\d*)\.jsonl$/.test(n))
    .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));
  for (const name of names) {
    if (next >= metadata.tail || frames.length >= maxFrames || bytes >= maxBytes) break;
    let text: string;
    try {
      text = (await readPrivateFile(join(dir, name), MAX_SEGMENT)).toString("utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        if (frames.length) {
          limited = true;
          break;
        }
        gap = true;
        previousEnd = undefined;
        continue;
      }
      throw error;
    }
    const complete = text.lastIndexOf("\n");
    if (complete < 0) continue;
    for (const line of text.slice(0, complete).split("\n")) {
      const f = frame(line, stream);
      if (f.sequence <= next) {
        if (f.sequence === next) previousEnd = f.end;
        continue;
      }
      if (f.sequence > metadata.tail) continue;
      if (f.sequence !== next + 1 || (previousEnd !== undefined && f.start !== previousEnd)) {
        if (frames.length) {
          limited = true;
          break;
        }
        gap = true;
        previousEnd = undefined;
        next = f.sequence - 1;
      }
      if (frames.length >= maxFrames || bytes + f.data.length > maxBytes) {
        limited = true;
        break;
      }
      frames.push(f);
      previousEnd = f.end;
      bytes += f.data.length;
      next = f.sequence;
    }
    if (limited) break;
  }
  if (
    next < metadata.tail &&
    frames.length < maxFrames &&
    bytes < maxBytes &&
    !limited &&
    !frames.length
  ) {
    gap = true;
    next = metadata.tail;
  }
  return { first: metadata.first, tail: metadata.tail, next, gap, health: metadata.health, frames };
}

/** Read the newest committed bytes without a forward scan that can stop short. */
export async function readJournalTail(dir: string, stream: string, maxBytes = 65536) {
  const metadata = await state(dir, stream);
  const names = (await readdir(dir))
    .filter((n) => /^(?:0|[1-9]\d*)\.jsonl$/.test(n))
    .sort((a, b) => Number.parseInt(b, 10) - Number.parseInt(a, 10));
  let expected = metadata.tail,
    nextStart: number | undefined,
    size = 0;
  let gap = metadata.first > 1,
    stopped = false;
  const parts: Frame[] = [];
  for (const name of names) {
    if (stopped || expected < metadata.first) break;
    let text: string;
    try {
      text = (await readPrivateFile(join(dir, name), MAX_SEGMENT)).toString("utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        gap = true;
        break;
      }
      throw error;
    }
    const end = text.lastIndexOf("\n");
    if (end < 0) continue;
    const lines = text.slice(0, end).split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const f = frame(lines[i], stream);
      if (f.sequence > expected || f.sequence < metadata.first) continue;
      if (f.sequence !== expected || (nextStart !== undefined && f.end !== nextStart)) {
        gap = true;
        if (parts.length) {
          stopped = true;
          break;
        }
        expected = f.sequence;
      }
      parts.push(f);
      size += f.data.length;
      expected = f.sequence - 1;
      nextStart = f.start;
      if (size >= maxBytes) {
        stopped = true;
        break;
      }
    }
  }
  if (expected >= metadata.first && !stopped) gap = true;
  const frames = parts.reverse();
  const combined = Buffer.concat(frames.map((f) => f.data));
  const data = combined.subarray(Math.max(0, combined.length - maxBytes));
  return {
    first: metadata.first,
    tail: metadata.tail,
    health: metadata.health,
    gap,
    truncated: gap || expected >= metadata.first || combined.length > maxBytes,
    data,
    frames,
  };
}
