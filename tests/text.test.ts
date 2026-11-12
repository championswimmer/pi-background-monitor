import assert from "node:assert/strict";
import { test } from "node:test";
import { TextNormalizer } from "../src/text.mjs";

test("incremental text normalization handles split UTF-8, controls and CRLF", () => {
  const normalizer = new TextNormalizer();
  const bytes = Buffer.from("a€\x1b]0;secret\x1b\\b\x1b[31mRED\x1b[0m\r\nnext\rfinal");
  let text = "";
  for (const byte of bytes) text += normalizer.write(Buffer.from([byte]));
  text += normalizer.end();
  assert.equal(text, "a€bRED\nnext\nfinal");
  assert.equal(normalizer.overflow, false);
  const checkpoint = new TextNormalizer();
  checkpoint.write(Buffer.concat([Buffer.from("before\x1b]secret"), Buffer.from([0xe2, 0x82])]));
  const resumed = new TextNormalizer(checkpoint.snapshot());
  const suffix = Buffer.concat([Buffer.from([0xac]), Buffer.from("\x07after\n")]);
  assert.equal(resumed.write(suffix), checkpoint.write(suffix));
  assert.deepEqual(resumed.snapshot(), checkpoint.snapshot());
  const long = new TextNormalizer();
  long.write(Buffer.from(`\x1b]${"x".repeat(4097)}`));
  assert.equal(long.overflow, true);
});
