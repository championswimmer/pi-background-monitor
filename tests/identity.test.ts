import assert from "node:assert/strict";
import { test } from "node:test";
import { readSubagentIdentity } from "../src/identity.ts";

const marker = (data: unknown) => ({ type: "custom", customType: "pi-subagent:thread:v1", data });
const valid = { rootId: "root-id_1", threadPath: "/root/child/grandchild", inheritedCount: 2 };

test("reads the subagent manager ownership entry", () => {
  assert.deepEqual(readSubagentIdentity([marker(valid)]), {
    group: "root-id_1",
    origin: "/root/child/grandchild",
    role: "subagent",
  });
});

test("rejects absent, ambiguous and malformed ownership entries", () => {
  for (const entries of [
    [],
    [marker(valid), marker(valid)],
    [marker(null)],
    [marker({ ...valid, rootId: "../bad" })],
    [marker({ ...valid, threadPath: "/root/../bad" })],
    [marker({ ...valid, threadPath: "/root" })],
    [marker({ ...valid, inheritedCount: -1 })],
    [{ type: "message", customType: "pi-subagent:thread:v1", data: valid }],
  ]) {
    assert.equal(readSubagentIdentity(entries), undefined);
  }
});
