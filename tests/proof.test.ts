import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clearStopEvidence,
  getStopEvidence,
  rememberStopEvidence,
  writeStopEvidence,
} from "../src/proof.ts";
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
    assert.equal(getStopEvidence(dir), latest, "late old success cannot clear newer evidence");
    await writeStopEvidence(dir, latest, async (_path, proof) => {
      writes.push(proof.state);
    });
    clearStopEvidence(dir, latest);
    await assert.rejects(writeStopEvidence(dir, old, slow), /superseded/);
    assert.deepEqual(writes, ["exited", "cancelled"]);
  } finally {
    release();
    const current = getStopEvidence(dir);
    if (current) clearStopEvidence(dir, current);
  }
});

test("a proof that succeeds after timeout clears only its current evidence", async () => {
  const dir = "/test/late-proof-success";
  const entry = rememberStopEvidence(dir, { version: 1, stream: "stream", state: "exited" }, true);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await assert.rejects(
      boundedIo(
        () =>
          writeStopEvidence(dir, entry, async () => {
            await gate;
          }),
        10,
      ),
      /timed out/,
    );
    assert.equal(getStopEvidence(dir), entry);
    release();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(getStopEvidence(dir), undefined);
  } finally {
    release();
    clearStopEvidence(dir, entry);
  }
});
