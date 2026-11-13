import { randomBytes } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readPrivateFile } from "./journal.ts";

export type StopProof = {
  version: 1;
  stream: string;
  state: "exited" | "cancelled" | "capture_failed" | "lost" | "unstarted";
  exitCode?: number;
  signal?: string;
};
type Evidence = { proof: StopProof; confirmed: boolean };
const evidenceKey = Symbol.for("pi-background-monitor:live-stop-evidence:v1");
const root = globalThis as typeof globalThis & { [evidenceKey: symbol]: unknown };
if (!root[evidenceKey]) root[evidenceKey] = new Map();
const evidence = root[evidenceKey] as Map<string, Evidence>;
/** Bounded, process-local evidence; never adopts a producer or restores a watch. */
export function rememberStopEvidence(dir: string, proof: StopProof, confirmed: boolean) {
  if (!evidence.has(dir) && evidence.size >= 128)
    throw new Error("Stop evidence capacity exhausted");
  const entry = { proof, confirmed };
  evidence.set(dir, entry);
  return entry;
}
export function getStopEvidence(dir: string) {
  return evidence.get(dir);
}
export function clearStopEvidence(dir: string, entry: Evidence) {
  if (evidence.get(dir) === entry) evidence.delete(dir);
}
export async function writeStopProof(dir: string, proof: StopProof) {
  const tmp = join(dir, `stopped-${randomBytes(8).toString("hex")}.tmp`);
  try {
    await writeFile(tmp, JSON.stringify(proof), { mode: 0o600, flag: "wx" });
    await rename(tmp, join(dir, "stopped.json"));
  } finally {
    await rm(tmp, { force: true }).catch(() => {});
  }
}
const writingKey = Symbol.for("pi-background-monitor:proof-writing:v1");
if (!root[writingKey]) root[writingKey] = new Map();
const writing = root[writingKey] as Map<string, Promise<void>>;
/** Reject, rather than queue, retries while an uncancellable older write is pending. */
export async function writeStopEvidence(
  dir: string,
  entry: Evidence,
  write: (dir: string, proof: StopProof) => Promise<void> = writeStopProof,
) {
  if (!entry.confirmed || evidence.get(dir) !== entry) throw new Error("Stop evidence superseded");
  if (writing.has(dir)) throw new Error("Stop proof write still in progress");
  const operation = write(dir, entry.proof);
  writing.set(dir, operation);
  try {
    await operation;
    clearStopEvidence(dir, entry);
  } finally {
    if (writing.get(dir) === operation) writing.delete(dir);
  }
}
export async function readStopProof(dir: string, stream: string): Promise<StopProof> {
  const proof = JSON.parse(
    (await readPrivateFile(join(dir, "stopped.json"), 4096)).toString("utf8"),
  );
  if (
    proof.version !== 1 ||
    proof.stream !== stream ||
    !["exited", "cancelled", "capture_failed", "lost", "unstarted"].includes(proof.state) ||
    (proof.exitCode !== undefined &&
      (!Number.isInteger(proof.exitCode) || proof.exitCode < 0 || proof.exitCode > 255)) ||
    (proof.signal !== undefined && (typeof proof.signal !== "string" || proof.signal.length > 32))
  )
    throw new Error("Invalid stopped-source proof");
  return proof;
}
