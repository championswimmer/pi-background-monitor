import assert from "node:assert/strict";
import { test } from "node:test";
import { clearStopEvidence, rememberStopEvidence, writeStopEvidence } from "../src/proof.ts";
import { boundedIo } from "../src/tmux.ts";

test("timed-out old proof writes cannot overtake newer source evidence", async () => {
  const dir = "/test/serialized-proof";
  const old = rememberStopEvidence(dir, { version: 1, stream: "stream", state: "exited" }, true);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const writes: string[] = [];
  const slow = async (_: string, proof: { state: string }) => {
    await gate;
    writes.push(proof.state);
  };
  try {
    await assert.rejects(
      boundedIo(() => writeStopEvidence(dir, old, slow), 10),
      /timed out/,
    );
    const latest = rememberStopEvidence(
      dir,
      { version: 1, stream: "stream", state: "cancelled" },
      true,
    );
    await assert.rejects(writeStopEvidence(dir, latest, slow), /in progress/);
    release();
    await new Promise((resolve) => setImmediate(resolve));
    await writeStopEvidence(dir, latest, async (_path, proof) => {
      writes.push(proof.state);
    });
    clearStopEvidence(dir, latest);
    await assert.rejects(writeStopEvidence(dir, old, slow), /superseded/);
    assert.deepEqual(writes, ["exited", "cancelled"]);
  } finally {
    release();
    const { getStopEvidence } = await import("../src/proof.ts");
    const current = getStopEvidence(dir);
    if (current) clearStopEvidence(dir, current);
  }
});
