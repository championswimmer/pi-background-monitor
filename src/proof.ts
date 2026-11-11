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
export async function writeStopProof(dir: string, proof: StopProof) {
  const tmp = join(dir, `stopped-${randomBytes(8).toString("hex")}.tmp`);
  try {
    await writeFile(tmp, JSON.stringify(proof), { mode: 0o600, flag: "wx" });
    await rename(tmp, join(dir, "stopped.json"));
  } finally {
    await rm(tmp, { force: true }).catch(() => {});
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
