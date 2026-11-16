import { test } from "node:test";
import assert from "node:assert/strict";
import { applied, notApplied, partial, conflict, readResult, assertShape, RESULT_SHAPE, q, toToolResult, type MwsResult } from "../src/index.js";

const text = (r: { content: Array<{ type: string; text?: unknown }> }) => String(r.content[0]!.text);

test("applied: receipt in structuredContent, mirrored in text, no isError", () => {
  const r = applied({ summary: `updated note ${q("n-1")}`, object: { id: "n-1", version: 4 }, changed: ["title", "tags"], settleWith: "get_note" });
  assert.equal(r.isError, undefined);
  assert.deepEqual(r.structuredContent, { mws: RESULT_SHAPE, outcome: "applied", safe_to_repeat: false, object: { id: "n-1", version: 4 }, changed: ["title", "tags"], settle_with: "get_note" });
  const t = text(r);
  assert.match(t, /^Applied: updated note "n-1"\./);
  assert.match(t, /Object: id "n-1", version 4\./);
  assert.match(t, /Changed fields: "title", "tags"\./);
  assert.match(t, /Read it with "get_note"\./);
  assert.match(t, /Safe to repeat: no\./);
});

test("applied with no change says so (empty changed list)", () => {
  const r = applied({ summary: "nothing to change", object: { id: 7 }, changed: [] });
  assert.deepEqual(readResult(r)!.changed, []);
  assert.match(text(r), /Changed fields: none\./);
});

test("fields that are not relevant are omitted, not null", () => {
  const r = notApplied({ summary: "note \"n-9\" was not found" });
  assert.deepEqual(Object.keys(r.structuredContent!).sort(), ["mws", "outcome", "safe_to_repeat"]);
  assert.equal(r.isError, true);
  assert.match(text(r), /^Not applied: note "n-9" was not found\. Nothing was changed\./);
  assert.match(text(r), /Safe to repeat: yes\./);
});

test("partial: not a success, names every applied and failed item", () => {
  const r = partial({ summary: "deleted 2 of 3 notes", applied: [{ id: "n-1", version: 2 }, { id: "n-2", version: 1 }], failed: [{ id: "n-3", reason: "locked" }] });
  assert.equal(r.isError, true);
  const s = readResult(r)!;
  assert.equal(s.outcome, "not_applied");
  assert.equal(s.safe_to_repeat, false);
  const t = text(r);
  assert.match(t, /^Not applied in full: deleted 2 of 3 notes\. Some items remain applied/);
  assert.match(t, /Applied items \(2\): "n-1" \(version 2\), "n-2" \(version 1\)\./);
  assert.match(t, /Items not applied \(1\): "n-3" \("locked"\)\./);
  assert.doesNotMatch(t, /Nothing was changed/);
});

test("partial with nothing applied is a plain refusal that names every item", () => {
  const r = partial({ summary: "the batch was refused", applied: [], failed: [{ id: "a", reason: "not found" }, { id: "b", reason: "not attempted" }] });
  const t = text(r);
  assert.match(t, /^Not applied: the batch was refused\. Nothing was changed\./);
  assert.match(t, /"a" \("not found"\), "b" \("not attempted"\)/);
});

test("conflict: error, nothing applied, version on its own, state as JSON, no resend advice", () => {
  const r = conflict({ id: "n-3", noun: "note", currentVersion: 3, currentState: { title: "Docs", tags: ["content", "v3"] }, readTool: "get_note" });
  assert.equal(r.isError, true);
  const s = readResult(r)!;
  assert.deepEqual(s.conflict, { current_version: 3, current_state: { title: "Docs", tags: ["content", "v3"] } });
  assert.equal(s.outcome, "not_applied");
  assert.equal(s.settle_with, "get_note");
  const t = text(r);
  assert.match(t, /^Not applied: note "n-3" changed since the version you read/);
  assert.match(t, /Nothing was changed\./);
  assert.match(t, /^Current version: 3\.$/m);
  assert.match(t, /^Current state \(JSON\): \{"title":"Docs","tags":\["content","v3"\]\}$/m);
  assert.match(t, /read it again with "get_note"/);
  assert.match(t, /Do not resend your earlier values with the new expected_version/);
});

test("conflict uses the write tool's version argument name", () => {
  const t = text(conflict({ id: 1, currentVersion: "W/\"abc\"", currentState: {}, readTool: "get", versionArg: "if_match" }));
  assert.match(t, /send if_match "W\/\\"abc\\"" with your change/);
});

test("assertShape refuses broken invariants", () => {
  const base: MwsResult = { mws: RESULT_SHAPE, outcome: "unknown", safe_to_repeat: false };
  assert.throws(() => assertShape(base), /settle_with/);
  assert.throws(() => assertShape({ ...base, outcome: "applied", failed: [{ id: 1, reason: "x" }] }), /failed/);
  assert.throws(() => assertShape({ ...base, outcome: "applied", conflict: { current_version: 1, current_state: {} } }), /conflict/);
  assert.throws(() => assertShape({ ...base, outcome: "maybe" as never, settle_with: "x" }), /outcome/);
  assert.throws(() => toToolResult({ ...base, mws: "result/v1" as never, settle_with: "x" }, { summary: "x" }), /mws/);
});

test("every structured value appears in the text (mirror)", () => {
  const r = partial({ summary: "s", applied: [{ id: "id-applied", version: "ver-77" }], failed: [{ id: "id-failed", reason: "reason-x" }], settleWith: "read_tool_x" });
  const t = text(r);
  for (const v of ["id-applied", "ver-77", "id-failed", "reason-x", "read_tool_x"]) assert.ok(t.includes(JSON.stringify(v)), v);
});
