import assert from "node:assert/strict";
import { test } from "node:test";
import { bounded, quote, sanitize } from "../src/output.ts";

test("bounded and sanitize untrusted output", () => {
  assert.equal(sanitize("a\x1b]0;secret\x07b\x1b[31mc\x00"), "abc");
  assert.equal(bounded("one\ntwo\nthree", 100, 2).text, "two\nthree");
  assert.deepEqual(bounded("ééé", 5), { text: "éé", truncated: true });
  assert.equal(quote("a'b"), "'a'\\''b'");
});
test("timed filesystem admission holds slots until underlying operations settle", async () => {
  const { boundedIo } = await import("../src/tmux.ts");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const operations = Array.from({ length: 16 }, () =>
    boundedIo(() => gate, 10).catch(() => undefined),
  );
  try {
    await Promise.all(operations);
    let launched = false;
    await assert.rejects(
      boundedIo(async () => {
        launched = true;
      }, 100),
      /capacity exhausted/,
    );
    assert.equal(launched, false);
  } finally {
    release();
    await gate;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(await boundedIo(async () => "ok", 100), "ok");
});
