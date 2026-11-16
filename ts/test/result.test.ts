import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { applied, notApplied, itemsResult, accepted, conflict, readResult, assertShape, toToolResult, pointer, pointerOf, isErrorFor, q, SHAPE, WRITE_RESULT_SCHEMA, outputSchemaFor, type WriteResult } from "../src/index.js";

const text = (r: { content: Array<{ type: string; text?: unknown }> }, i = 0) => String(r.content[i]!.text);
const mws = (r: { structuredContent?: Record<string, unknown> }) => r.structuredContent!["mws"] as Record<string, unknown>;

test("applied: the shape under structuredContent.mws, a sentence, then the JSON", () => {
  const r = applied({ summary: `updated note ${q("n-1")}`, operation: "update", object: { type: "note", id: "n-1", version: 4 }, changed: ["title", "/tags"], readWith: { tool: "get_note", arguments: { id: "n-1" } } });
  assert.equal(r.isError, undefined);
  assert.deepEqual(mws(r), {
    shape: "write-result/0.1", outcome: "applied", repeat: "no", operation: "update",
    object: { type: "note", id: "n-1", version: "4" }, changed: ["/title", "/tags"], read_with: { tool: "get_note", arguments: { id: "n-1" } },
  });
  assert.equal(r.content.length, 2);
  assert.match(text(r), /^Applied: updated note "n-1"\./);
  assert.match(text(r), /Changed: "\/title", "\/tags"\./);
  assert.match(text(r), /Version now: "4"\./);
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
  assert.throws(() => applied({ summary: "x", own: { mws: 1 } }), /mws/);
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
});

test("accepted: not an error, repeat no", () => {
  const r = accepted({ summary: "the export was queued", readWith: { tool: "get_export", arguments: { id: "e1" } } });
  assert.equal(r.isError, undefined);
  assert.equal(mws(r)["outcome"], "accepted");
  assert.match(text(r), /^Accepted: the export was queued\. The backend has not yet reported the result\./);
});

test("conflict: code, read_first, version on its own as a string, state as JSON, version_argument", () => {
  const r = conflict({ id: "n-3", type: "note", currentVersion: 3, currentState: { title: "Docs", tags: ["content", "v3"] }, omitted: ["body"], readWith: { tool: "get_note", arguments: { id: "n-3" } } });
  assert.equal(r.isError, true);
  assert.deepEqual(mws(r), {
    shape: SHAPE, outcome: "not_applied", repeat: "read_first", object: { type: "note", id: "n-3" }, code: "conflict",
    message: `note "n-3" changed since the version you read; it is now at version 3.`,
    conflict: { current_version: "3", version_source: "backend", current_state: { title: "Docs", tags: ["content", "v3"] }, omitted: ["/body"] },
    read_with: { tool: "get_note", arguments: { id: "n-3" } }, version_argument: "expected_version",
  });
  assert.match(text(r), /^Not applied: note "n-3" changed since the version you read; it is now at version 3\. Nothing was changed\./);
  assert.match(text(r), /Before writing again, read it with "get_note"/, "with fields omitted, the text asks for a read");
  const full = conflict({ id: 1, currentVersion: "e1", currentState: { a: 1 }, readWith: { tool: "get", arguments: { id: 1 } } });
  assert.match(text(full), /Build the write again from the current state in the JSON below.*do not resend your earlier values/);
});

test("conflict without a version leaves current_version out (never null); a lock carries held_by", () => {
  const r = conflict({ id: "d", code: "locked", heldBy: "user ann", readWith: { tool: "get", arguments: {} } });
  const c = mws(r)["conflict"] as Record<string, unknown>;
  assert.equal("current_version" in c, false);
  assert.equal("version_source" in c, false);
  assert.equal(c["held_by"], "user ann");
  assert.equal(mws(r)["code"], "locked");
});

test("assertShape enforces B-9's rules", () => {
  const base: WriteResult = { shape: SHAPE, outcome: "unknown" };
  assert.throws(() => assertShape({ ...base, repeat: "yes" }), /repeat "yes"/);
  assert.throws(() => assertShape({ ...base, outcome: "partial", repeat: "yes" }), /repeat "yes"/);
  assert.throws(() => assertShape({ ...base, outcome: "not_applied", object: { version: "1" } }), /object.version/);
  assert.throws(() => assertShape({ ...base, outcome: "not_applied", code: "conflict", conflict: { current_version: "2" }, repeat: "no" }), /current_version needs/);
  assert.throws(() => assertShape({ ...base, conflict: {} }), /conflict is present only/);
  assert.throws(() => assertShape({ ...base, code: "Bad-Code" }), /lowercase/);
  assert.throws(() => assertShape({ ...base, changed: ["title"] }), /JSON Pointer/);
  assert.throws(() => assertShape({ ...base, items: [{ index: -1, outcome: "applied" }] }), /index/);
  assert.throws(() => toToolResult({ ...base, shape: "result/v0" as never }, { summary: "x" }), /shape/);
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
  assert.equal(readResult({ structuredContent: { mws: { shape: "write-result/0.1", outcome: "done" } } }), undefined);
  assert.equal(readResult({ structuredContent: { mws: "result/v0" } }), undefined);
  const r = readResult({ structuredContent: { mws: { shape: "write-result/0.7", outcome: "unknown", repeat: "maybe", future: 1, changed: "title", code: "no_answer", read_with: { tool: "get", arguments: {} } } } })!;
  assert.deepEqual(r, { shape: "write-result/0.7", outcome: "unknown", code: "no_answer", read_with: { tool: "get", arguments: {} } }, "unknown and malformed members are dropped");
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
  assert.deepEqual(s["if"], { properties: { mws: { properties: { outcome: { const: "applied" } } } } });
  assert.deepEqual(s["then"], { required: ["note"] });
  assert.equal("if" in outputSchemaFor(), false);
});
