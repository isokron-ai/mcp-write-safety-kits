import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { RESERVED_CODES, applied, notApplied, itemsResult, accepted, conflict, readResult, assertShape, toToolResult, pointer, pointerOf, isErrorFor, q, SHAPE, WRITE_RESULT_SCHEMA, outputSchemaFor, type WriteResult } from "../src/index.js";

const text = (r: { content: Array<{ type: string; text?: unknown }> }, i = 0) => String(r.content[i]!.text);
const mws = (r: { structuredContent?: Record<string, unknown> }) => r.structuredContent!["mws"] as Record<string, unknown>;

test("applied: the shape under structuredContent.mws, a sentence, then the JSON", () => {
  const r = applied({ summary: `updated note ${q("n-1")}`, operation: "update", object: { type: "note", id: "n-1", version: 4 }, changed: ["title", "/tags"], readWith: { tool: "get_note", arguments: { id: "n-1" } } });
  assert.equal(r.isError, undefined);
  assert.deepEqual(mws(r), {
    shape: "write-result/0.1", outcome: "applied", repeat: "no", operation: "update",
    object: { type: "note", id: "n-1", version: 4 }, changed: ["/title", "/tags"], read_with: { tool: "get_note", arguments: { id: "n-1" } },
  });
  assert.equal(r.content.length, 2);
  assert.match(text(r), /^Applied: updated note "n-1"\./);
  assert.match(text(r), /Changed: "\/title", "\/tags"\./);
  assert.match(text(r), /Version now: 4\./);
  assert.match(text(r), /Do not send the same call again\./);
  assert.deepEqual(JSON.parse(text(r, 1)), r.structuredContent);
});

test("applied with changed: [] says nothing changed; a delete leaves changed out", () => {
  assert.deepEqual(mws(applied({ summary: "x", changed: [] }))["changed"], []);
  assert.match(text(applied({ summary: "x", changed: [] })), /Changed: nothing\./);
  assert.equal(mws(applied({ summary: "deleted", operation: "delete" }))["changed"], undefined);
});

test("the tool's own output sits beside mws", () => {
  const r = applied({ summary: "x", own: { note: { id: "n-1" } } });
  assert.deepEqual(Object.keys(r.structuredContent!).sort(), ["mws", "note"]);
  const bad = applied({ summary: "x", own: { mws: 1 } });
  assert.deepEqual([readResult(bad)!.outcome, readResult(bad)!.code], ["unknown", "internal_error"], "fails closed");
});

test("notApplied: isError, code, message, argument as a pointer, no object version", () => {
  const r = notApplied({ summary: `notebook ${q("x")} was not found`, code: "not_found", object: { type: "notebook", id: "x", version: 3 } });
  assert.equal(r.isError, true);
  assert.deepEqual(mws(r), { shape: SHAPE, outcome: "not_applied", repeat: "no", object: { type: "notebook", id: "x" }, code: "not_found", message: `notebook "x" was not found.` });
  assert.match(text(r), /^Not applied: notebook "x" was not found\. Nothing was changed\./);
  assert.equal(mws(notApplied({ summary: "s", argument: "title" }))["argument"], "/title");
});

test("itemsResult derives the outcome from the items", () => {
  const it = (outcome: "applied" | "not_applied" | "not_attempted" | "unknown", i: number) => ({ index: i, id: `n-${i}`, outcome });
  assert.equal(mws(itemsResult({ summary: "s", items: [it("applied", 0), it("applied", 1)] }))["outcome"], "applied");
  const rw = { tool: "list_notes", arguments: {} };
  const p = itemsResult({ summary: "deleted 1 of 2", readWith: rw, items: [it("applied", 0), { ...it("not_applied", 1), code: "not_found", message: "no such note" }] });
  assert.equal(p.isError, true);
  assert.equal(mws(p)["outcome"], "partial");
  assert.equal(mws(p)["repeat"], "read_first");
  assert.match(text(p), /^Partly applied: deleted 1 of 2\./);
  assert.equal(mws(itemsResult({ summary: "s", items: [it("not_applied", 0), it("not_attempted", 1)] }))["outcome"], "not_applied");
  assert.equal(mws(itemsResult({ summary: "s", readWith: rw, items: [it("applied", 0), it("unknown", 1)] }))["outcome"], "unknown", "unknown wins over partial");
  assert.equal(mws(itemsResult({ summary: "s", items: [], appliedCount: 3 }))["applied_count"], 3);
  assert.equal(mws(itemsResult({ summary: "matched nothing", items: [], appliedCount: 0 }))["outcome"], "applied");
  const aon = itemsResult({ summary: "refused", items: [{ index: 0, id: "a", outcome: "not_attempted" }, { index: 1, id: "b", outcome: "not_applied", code: "not_found" }] });
  assert.deepEqual([mws(aon)["outcome"], mws(aon)["code"]], ["not_applied", "not_found"], "all-or-nothing: top code from the bad item");
  const multi = itemsResult({ summary: "stale", readWith: rw, items: [{ index: 0, id: 1, outcome: "not_applied", code: "conflict", conflict: { current_version: 4, checked_by: "server" } }, { index: 1, id: 2, outcome: "not_attempted" }] });
  assert.deepEqual([mws(multi)["code"], mws(multi)["repeat"], "conflict" in mws(multi)], ["conflict", "read_first", false], "per-item conflicts, none at the top");
});

test("accepted: not an error, repeat no (same_key with a key), no changed and no version", () => {
  const r = accepted({ summary: "the export was queued", readWith: { tool: "get_export", arguments: { id: "e1" } } });
  assert.equal(r.isError, undefined);
  assert.equal(mws(r)["outcome"], "accepted");
  assert.match(text(r), /^Accepted: the export was queued\. The backend has not yet reported the result\./);
  assert.equal(mws(accepted({ summary: "q", repeat: "same_key", key: "key-00000001", keyArgument: "idempotency_key", readWith: { tool: "g", arguments: {} } }))["repeat"], "same_key");
});

test("conflict: code, read_first, integer version on its own, state as JSON, checked_by, version_argument", () => {
  const r = conflict({ id: "n-3", type: "note", sentVersion: 2, currentVersion: 3, currentState: { title: "Docs", tags: ["content", "v3"] }, omitted: ["body"], readWith: { tool: "get_note", arguments: { id: "n-3" } } });
  assert.equal(r.isError, true);
  assert.deepEqual(mws(r), {
    shape: SHAPE, outcome: "not_applied", repeat: "read_first", object: { type: "note", id: "n-3" }, code: "conflict",
    message: `note "n-3" changed since version 2.`,
    conflict: { current_version: 3, checked_by: "server", current_state: { title: "Docs", tags: ["content", "v3"] }, omitted: ["/body"] },
    read_with: { tool: "get_note", arguments: { id: "n-3" } }, version_argument: "expected_version",
  });
  assert.match(text(r), /^Not applied: note "n-3" changed since version 2\. Nothing was changed\.\nIts current state and version are in the JSON below\./);
  assert.doesNotMatch(text(r), /Docs|content/, "the sentence never restates current_state");
  assert.match(text(r), /Before writing again, read it with "get_note"/, "with fields omitted, the text asks for a read");
  const full = conflict({ id: 1, currentVersion: "e1", currentState: { a: 1 }, checkedBy: "backend", readWith: { tool: "get", arguments: { id: 1 } } });
  assert.match(text(full), /Build the write again from them.*do not resend your earlier values/);
  assert.equal((mws(full)["conflict"] as Record<string, unknown>)["checked_by"], "backend");
});

test("conflict without a version leaves current_version out (never null); a lock carries held_by", () => {
  const r = conflict({ id: "d", code: "locked", heldBy: "user ann", readWith: { tool: "get", arguments: {} } });
  const c = mws(r)["conflict"] as Record<string, unknown>;
  assert.equal("current_version" in c, false);
  assert.equal(c["held_by"], "user ann");
  assert.equal(mws(r)["code"], "locked");
  assert.equal(mws(r)["repeat"], "read_first");
});

test("assertShape enforces B-9's rules", () => {
  const base: WriteResult = { shape: SHAPE, outcome: "unknown" };
  assert.throws(() => assertShape({ ...base, repeat: "yes" }), /repeat "yes"/);
  assert.throws(() => assertShape({ ...base, outcome: "applied", repeat: "yes" }), /repeat "yes"/);
  assert.throws(() => assertShape({ ...base, outcome: "not_applied", object: { version: 1 } }), /object.version/);
  assert.throws(() => assertShape({ ...base, outcome: "not_applied", code: "conflict", repeat: "no" }), /read_first/);
  assert.throws(() => assertShape({ ...base, outcome: "not_applied", code: "no_answer" }), /goes with outcome "unknown"/);
  assert.throws(() => assertShape({ ...base, code: "not_found" }), /goes with outcome "not_applied"/);
  assert.throws(() => assertShape({ ...base, conflict: {} }), /conflict is present only/);
  assert.throws(() => assertShape({ ...base, code: "Bad-Code" }), /lowercase/);
  assert.throws(() => assertShape({ ...base, changed: ["title"] }), /JSON Pointer/);
  assert.throws(() => assertShape({ ...base, items: [{ index: -1, outcome: "applied" }] }), /index/);
  assert.throws(() => assertShape({ ...base, items: [{ outcome: "applied" }] }), /index, step or id/);
  assert.throws(() => assertShape({ ...base, object: { id: 2 ** 60 } }), /identifier or version/);
  assert.throws(() => assertShape({ ...base, object: { id: 1.5 } }), /identifier or version/);
  assert.throws(() => assertShape({ ...base, outcome: "accepted", changed: [] }), /accepted/);
  assert.throws(() => assertShape({ ...base, argument_errors: [{ argument: "x" }] }), /JSON Pointer/);
  assertShape({ ...base, code: "my_own_code", items: [{ id: 7, outcome: "unknown", conflict: { current_version: 3 } }], object: { id: "a", parent: { type: "t", id: 1, version: 2 } } });
  assert.throws(() => assertShape({ ...base, shape: "result/v0" as never }), /shape/);
});

test("a malformed shape fails closed as internal_error", () => {
  const r = toToolResult({ shape: SHAPE, outcome: "not_applied", code: "no_answer", read_with: { tool: "g", arguments: {} } }, { summary: "x" });
  assert.equal(r.isError, true);
  assert.deepEqual([mws(r)["outcome"], mws(r)["code"], mws(r)["repeat"]], ["unknown", "internal_error", "read_first"]);
  assert.deepEqual(mws(r)["read_with"], { tool: "g", arguments: {} });
});

test("the JSON block is exactly JSON.stringify(structuredContent)", () => {
  for (const r of [applied({ summary: "a", own: { x: 1 } }), conflict({ id: 1, readWith: { tool: "g", arguments: {} }, currentVersion: 2 }), notApplied({ summary: "n" })]) {
    assert.equal(text(r, 1), JSON.stringify(r.structuredContent));
  }
});

test("13 reserved codes, each with its outcome", () => {
  assert.equal(Object.keys(RESERVED_CODES).length, 13);
  const file = JSON.parse(readFileSync(new URL("../../schema/write-result-0.1.schema.json", import.meta.url), "utf8"));
  for (const c of Object.keys(RESERVED_CODES)) assert.match(file.properties.code.$comment, new RegExp(`\\b${c}\\b`));
});

test("isError follows the outcome", () => {
  assert.deepEqual((["applied", "not_applied", "partial", "unknown", "accepted"] as const).map(isErrorFor), [false, true, true, true, false]);
});

test("pointers escape ~ and /", () => {
  assert.equal(pointer("a/b~c"), "/a~1b~0c");
  assert.equal(pointer("/already"), "/already");
  assert.equal(pointerOf(["tags", 2]), "/tags/2");
});

test("readResult follows the reader rules", () => {
  const ok = applied({ summary: "x", object: { id: 1 } });
  assert.equal(readResult(ok)!.outcome, "applied");
  assert.equal(readResult({ structuredContent: { mws: { shape: "write-result/1.0", outcome: "applied" } } }), undefined, "another MAJOR decides nothing");
  assert.equal(readResult({ structuredContent: { mws: { shape: "write-result/0.2", outcome: "applied" } } }), undefined, "before 1.0, another MINOR decides nothing");
  assert.equal(readResult({ structuredContent: { mws: "result/v0" } }), undefined);
  const noOutcome = readResult({ structuredContent: { mws: { shape: "write-result/0.1", outcome: "done", repeat: "yes" } } })!;
  assert.deepEqual(noOutcome, { shape: "write-result/0.1", repeat: "yes" }, "other members are read without a valid outcome");
  const r = readResult({ structuredContent: { mws: { shape: "write-result/0.1", outcome: "unknown", repeat: "maybe", future: 1, changed: "title", code: "no_answer", object: { id: 8, version: 1.5 }, read_with: { tool: "get", arguments: {} } } } })!;
  assert.deepEqual(r, { shape: "write-result/0.1", outcome: "unknown", object: { id: 8 }, code: "no_answer", read_with: { tool: "get", arguments: {} } }, "unknown and malformed members are dropped");
});

test("the shipped JSON Schema file equals the exported schema", () => {
  const file = JSON.parse(readFileSync(new URL("../../schema/write-result-0.1.schema.json", import.meta.url), "utf8"));
  assert.deepEqual(file, JSON.parse(JSON.stringify(WRITE_RESULT_SCHEMA)));
});

test("outputSchemaFor: mws required and inlined; own members required only when applied", () => {
  const s = outputSchemaFor({ properties: { note: { type: "object" } }, required: ["note"] }) as Record<string, any>;
  assert.deepEqual(s["required"], ["mws"]);
  assert.equal(s["properties"]["mws"]["$ref"], "#/$defs/write_result");
  assert.equal(s["$defs"]["write_result"]["properties"]["outcome"]["enum"].length, 5);
  assert.ok(s["$defs"]["idv"] && s["$defs"]["conflict"], "the shape's $defs are hoisted so its references resolve");
  assert.doesNotMatch(JSON.stringify(s), /"additionalProperties":false/);
  assert.deepEqual(s["if"], { properties: { mws: { properties: { outcome: { const: "applied" } } } } });
  assert.deepEqual(s["then"], { required: ["note"] });
  assert.equal("if" in outputSchemaFor(), false);
});
