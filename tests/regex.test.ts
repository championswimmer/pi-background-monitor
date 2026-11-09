import assert from "node:assert/strict";
import { test } from "node:test";
import { RegexMatcher } from "../src/regex.ts";

test("regex worker matches flags, rejects syntax, and recovers after timeout", {
  timeout: 5000,
}, async () => {
  const matcher = new RegexMatcher();
  try {
    assert.equal(await matcher.test("^error TS\\d+", "im", "prefix\nERROR TS123"), true);
    assert.equal(await matcher.test("a.b", "s", "a\nb"), true);
    assert.equal(await matcher.test("^$", "", ""), true);
    await assert.rejects(matcher.test("(", ""), /Invalid regex syntax/);
    let responsive = false;
    const timer = setTimeout(() => {
      responsive = true;
    }, 20);
    await assert.rejects(matcher.test("^(a+)+$", "", `${"a".repeat(16000)}!`), /timed out/);
    clearTimeout(timer);
    assert.equal(responsive, true);
    assert.equal(await matcher.test("ok", "", "ok"), true);
  } finally {
    matcher.close();
  }
});
