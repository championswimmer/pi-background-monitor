// Standalone tmux pipe sink. Only one bounded stdin chunk is in flight.
import { open, rename, unlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TextNormalizer } from "./text.mjs";

const [dir, nonce, stream] = process.argv.slice(2);
const MAX_SEGMENT = 1024 * 1024;
const MAX_SEGMENTS = 8;
let sequence = 0,
  offset = 0,
  bytes = 0,
  file;
const segments = [];
const normalizer = new TextNormalizer();
const state = {
  version: 1,
  nonce,
  stream,
  pid: process.pid,
  first: 0,
  tail: 0,
  offset: 0,
  health: "starting",
  generation: 0,
  firstText: normalizer.snapshot(),
  tailText: normalizer.snapshot(),
};
async function publish() {
  if (state.generation >= Number.MAX_SAFE_INTEGER) throw new Error("Capture generation exhausted");
  state.generation++;
  const tmp = join(dir, "capture.tmp");
  await writeFile(tmp, JSON.stringify(state), { mode: 0o600 });
  await rename(tmp, join(dir, "capture.json"));
}
async function publishProof() {
  const proof = {
    version: 1,
    stream,
    tail: state.tail,
    generation: state.generation,
    publishedClock: process.hrtime.bigint().toString(),
  };
  const tmp = join(dir, "published.tmp");
  await writeFile(tmp, JSON.stringify(proof), { mode: 0o600 });
  await rename(tmp, join(dir, "published.json"));
}
async function segment() {
  if (file) await file.close();
  const name = `${sequence + 1}.jsonl`;
  file = await open(join(dir, name), "wx", 0o600);
  segments.push({ name, first: sequence + 1, text: normalizer.snapshot() });
  bytes = 0;
  if (!state.first) state.first = sequence + 1;
}
async function writeAll(data) {
  let at = 0;
  while (at < data.length) {
    const { bytesWritten } = await file.write(data, at, data.length - at);
    if (!bytesWritten) throw new Error("capture write made no progress");
    at += bytesWritten;
  }
}
let heartbeat,
  pendingAt = 0,
  beatAt = 0;
try {
  if (!dir || !nonce || !stream) throw new Error("missing capture arguments");
  await segment();
  const beatPath = join(dir, "heartbeat");
  await writeFile(beatPath, "", { mode: 0o600, flag: "wx" });
  let beating = false;
  heartbeat = setInterval(() => {
    const time = Date.now();
    if ((pendingAt && time - pendingAt > 5000) || (beatAt && time - beatAt > 5000)) process.exit(1);
    if (beating) return;
    beating = true;
    beatAt = time;
    const now = new Date();
    utimes(beatPath, now, now)
      .catch(() => process.exit(1))
      .finally(() => {
        beating = false;
        beatAt = 0;
      });
  }, 1000);
  pendingAt = Date.now();
  await publish();
  await publishProof();
  state.health = "ready";
  await publish();
  await publishProof();
  pendingAt = 0;
  for await (const chunk of process.stdin) {
    for (let i = 0; i < chunk.length; i += 16 * 1024) {
      pendingAt = Date.now();
      const data = chunk.subarray(i, i + 16 * 1024);
      const frame = Buffer.from(
        `${JSON.stringify({ version: 1, stream, sequence: sequence + 1, timestamp: Date.now(), start: offset, end: offset + data.length, kind: "output", data: data.toString("base64") })}\n`,
      );
      if (bytes + frame.length > MAX_SEGMENT) await segment();
      await writeAll(frame);
      await file.sync();
      bytes += frame.length;
      sequence++;
      offset += data.length;
      normalizer.write(data);
      state.tail = sequence;
      state.offset = offset;
      state.tailText = normalizer.snapshot();
      // Publish the new committed frame before evicting the oldest segment.
      if (segments.length > MAX_SEGMENTS) {
        state.first = segments[1].first;
        state.firstText = segments[1].text;
      }
      await publish();
      await publishProof();
      if (segments.length > MAX_SEGMENTS) await unlink(join(dir, segments.shift().name));
      pendingAt = 0;
    }
  }
  pendingAt = Date.now();
  await file.close();
  file = undefined;
  state.health = "complete";
  await publish();
  await publishProof();
  pendingAt = 0;
} catch (error) {
  pendingAt = Date.now();
  try {
    if (file) {
      await file.close();
      file = undefined;
    }
    state.health = "failed";
    state.error = String(error).slice(0, 1024);
    await publish();
    await publishProof();
  } catch {
    /* A failed close or unavailable storage leaves capture uncertain. */
  }
  process.exitCode = 1;
} finally {
  if (file) {
    pendingAt = Date.now();
    await file.close().catch(() => {});
  }
  if (heartbeat) clearInterval(heartbeat);
}
