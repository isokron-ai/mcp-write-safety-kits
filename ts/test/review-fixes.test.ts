// Regression tests for the pre-release review: B-9 rules the builders enforce, the text mirror,
// error codes, key-store limits and schema checks.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applied, accepted, notApplied, itemsResult, conflict, guardWrite, unknownCode, OutcomeUnknownError,
  MemoryIdempotencyStore, withIdempotency, strictInput, validateArguments, SchemaError, q, type CallToolResult,
  NotAppliedError, classifyError, defineTool, outputSchemaFor,
} from "../src/index.js";

const RW = { tool: "get_note", arguments: { id: "n-1" } };
const mws = (r: CallToolResult) => (r.structuredContent as Record<string, Record<string, unknown>>)["mws"]!;
const text = (r: CallToolResult) => String((r.content[0] as { text: string }).text);
/** The kit fails closed: a shape that breaks a rule becomes an internal_error result naming the rule. */
const closed = (r: CallToolResult, why: RegExp) => {
  assert.equal(mws(r)["outcome"], "unknown");
  assert.equal(mws(r)["code"], "internal_error");
  assert.match(String(mws(r)["message"]), why);
};

test("the first text block names the read wherever read_with is given", () => {
  for (const r of [
    applied({ summary: "updated", readWith: RW }),
    accepted({ summary: "queued", readWith: RW }),
    notApplied({ summary: "locked", code: "locked", readWith: RW }),
    notApplied({ summary: "rate limited", code: "rate_limited", repeat: "yes", readWith: RW }),
  ]) assert.match(text(r), /"get_note"/, text(r));
});

test("read_first needs read_with or object.id", () => {
  const items = [{ index: 0, outcome: "applied" as const }, { index: 1, outcome: "not_applied" as const }];
  closed(itemsResult({ summary: "x", items }), /read_first/);
  assert.equal(mws(itemsResult({ summary: "x", items, object: { id: "nb-1" } }))["repeat"], "read_first");
});

test("repeat yes after applied (a delete included) is refused", () => {
  closed(applied({ summary: "deleted", operation: "delete", repeat: "yes" as never }), /repeat "yes"/);
});

test("same_key and same_version need the key or version the call carried", () => {
  closed(applied({ summary: "x", repeat: "same_key" }), /same_key/);
  closed(applied({ summary: "x", repeat: "same_version" }), /same_version/);
  assert.equal(mws(applied({ summary: "x", repeat: "same_key", key: "k-12345678", keyArgument: "idempotency_key" }))["repeat"], "same_key");
  assert.equal(mws(applied({ summary: "x", repeat: "same_version", sentVersion: 3, versionArgument: "expected_version" }))["repeat"], "same_version");
});

test("an open item is never under applied or not_applied", () => {
  closed(notApplied({ summary: "x", items: [{ index: 0, outcome: "unknown" }] }), /open outcome/);
  closed(notApplied({ summary: "x", items: [{ index: 0, outcome: "applied" }] }), /partial/);
});

test("a null or empty current version is left out, not written as a placeholder", () => {
  for (const v of [null, ""]) {
    const r = conflict({ id: "n-1", currentVersion: v as unknown as string, currentState: { t: 1 }, readWith: RW });
    const c = mws(r)["conflict"] as Record<string, unknown>;
    assert.equal(c["current_version"], undefined);
    assert.equal(Object.prototype.hasOwnProperty.call(c, "current_version"), false);
    assert.doesNotMatch(text(r), /version null/);
  }
});

test("no_answer only where the error shows a lost answer", async () => {
  assert.equal(unknownCode(Object.assign(new Error("t"), { code: "ETIMEDOUT" })), "no_answer");
  assert.equal(unknownCode(new OutcomeUnknownError("timeout after 30 s")), "no_answer");
  assert.equal(unknownCode(new TypeError("x is undefined")), "internal_error");
  const r = await guardWrite(async () => { throw new TypeError("bug"); }, { readWith: RW, what: "the write" });
  assert.equal(mws(r)["outcome"], "unknown");
  assert.equal(mws(r)["code"], "internal_error");
  assert.match(text(r), /stopped on a fault in the server/);
  const a = await guardWrite(async () => { throw Object.assign(new Error("aborted"), { name: "AbortError", code: "ABORT_ERR" }); }, { readWith: RW, what: "the write" });
  assert.equal(mws(a)["code"], "internal_error", "an abort is not a lost answer");
});

test("a full key store refuses a new key and never drops a live one", async () => {
  const store = new MemoryIdempotencyStore({ maxEntries: 2 });
  let writes = 0;
  const call = (key: string, fail = false) => withIdempotency({ store, scope: "s", args: { idempotency_key: key }, readWith: RW }, async () => {
    writes++;
    if (fail) throw Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
    return applied({ summary: `wrote ${q(key)}` });
  });
  const lost = await call("key-lost-1", true);
  assert.equal(mws(lost)["outcome"], "unknown");
  assert.equal(mws(lost)["code"], "no_answer");
  assert.equal(mws(lost)["repeat"], "read_first", "a same_key repeat would only replay the open answer");
  assert.match(text(lost), /new idempotency_key/);
  await call("key-ok-0001");
  const full = await call("key-ok-0002");
  assert.equal(mws(full)["code"], "key_store_full");
  assert.equal(mws(full)["outcome"], "not_applied");
  const again = await call("key-lost-1", true);
  assert.equal(mws(again)["outcome"], "unknown");
  assert.equal(mws(again)["replayed"], true);
  assert.equal(writes, 2, "the lost key was not dropped, so its repeat wrote nothing");
});

test("a second call does not wait for ever on a key in progress", async () => {
  const store = new MemoryIdempotencyStore();
  const args = { idempotency_key: "key-hung-01" };
  void withIdempotency({ store, scope: "s", args, readWith: RW }, () => new Promise<CallToolResult>(() => {}));
  const r = await withIdempotency({ store, scope: "s", args, readWith: RW, waitMs: 20 }, async () => applied({ summary: "x" }));
  assert.equal(mws(r)["code"], "in_progress");
  assert.equal(mws(r)["repeat"], "same_key");
});

test("a replay of a partial result does not repeat the fixed sentence", async () => {
  const store = new MemoryIdempotencyStore();
  const args = { idempotency_key: "key-part-01" };
  const write = async () => itemsResult({ summary: "deleted 1 of 2", readWith: RW, items: [{ index: 0, outcome: "applied" }, { index: 1, outcome: "not_applied" }] });
  await withIdempotency({ store, scope: "s", args, readWith: RW }, write);
  const r = await withIdempotency({ store, scope: "s", args, readWith: RW }, write);
  assert.equal(mws(r)["replayed"], true);
  assert.equal(text(r).split("Some items remain applied").length, 2, text(r));
});

test("schema keyword values are checked at definition time; untyped values stay open", () => {
  for (const bad of [
    { type: "object", properties: { n: { type: "number", exclusiveMinimum: true } } },
    { type: "object", properties: { o: { type: "object", additionalProperties: { type: "string" } } } },
    { type: "object", required: "a", properties: { a: { type: "string" } } },
  ]) assert.throws(() => strictInput(bad as never), SchemaError);
  const s = strictInput({ type: "object", properties: { any: { description: "any JSON value" } } });
  assert.equal(s.validate({ any: { nested: 1 } }).ok, true);
  assert.equal(s.validate({ other: 1 }).ok, false);
  assert.equal(validateArguments({ type: "object", properties: { a: { type: "string" } } }, { b: 1 }).length, 1, "a raw schema is closed as advertised");
});

// -- the third review: a thrown refusal names the read; nothing fails closed into a read it cannot name

test("a thrown conflict refusal stays not_applied, read_first, with the read", async () => {
  const r = await guardWrite(async () => { throw new NotAppliedError("note \"n-1\" changed since version 2", { code: "conflict" }); }, { readWith: RW, what: "the update" });
  assert.deepEqual([mws(r)["outcome"], mws(r)["code"], mws(r)["repeat"]], ["not_applied", "conflict", "read_first"]);
  assert.deepEqual(mws(r)["read_with"], RW);
  assert.match(text(r), /read it with "get_note"/);
});

test("a thrown refusal whose code is reserved for an open outcome is unknown", async () => {
  const r = await guardWrite(async () => { throw new NotAppliedError("the backend answered 503", { code: "backend_error" }); }, { readWith: RW, what: "the update" });
  assert.deepEqual([mws(r)["outcome"], mws(r)["code"], mws(r)["repeat"]], ["unknown", "backend_error", "read_first"]);
  assert.deepEqual(mws(r)["read_with"], RW);
});

test("a malformed result with no read to name fails closed with repeat no, never read_first", () => {
  const r = itemsResult({ summary: "x", items: [{ index: 0, outcome: "applied" }, { index: 1, outcome: "not_applied" }] });
  closed(r, /read_first/);
  assert.equal(mws(r)["repeat"], "no");
  assert.equal(mws(itemsResult({ summary: "x", object: { id: 0 }, items: [{ index: 0, outcome: "applied" }, { index: 1, outcome: "not_applied" }] }))["repeat"], "read_first", "object.id 0 names the object");
});

test("defineTool checks the handler's own result", async () => {
  const t = defineTool({
    kind: "write", name: "w", description: "d", inputSchema: { type: "object", properties: {} },
    hints: { destructive: false, idempotent: false, openWorld: false }, readWith: () => RW, outputSchema: outputSchemaFor(),
    handler: () => ({ content: [{ type: "text", text: "ok" }], structuredContent: { mws: { shape: "write-result/0.1", outcome: "applied", repeat: "yes" } } }),
  });
  const r = await t.call({});
  closed(r, /repeat "yes"/);
  assert.deepEqual(mws(r)["read_with"], RW);
  const plain = defineTool({
    kind: "write", name: "p", description: "d", inputSchema: { type: "object", properties: {} },
    hints: { destructive: false, idempotent: false, openWorld: false }, readWith: () => RW, outputSchema: outputSchemaFor(),
    handler: () => ({ content: [{ type: "text", text: "done" }] }),
  });
  closed(await plain.call({}), /did not carry/);
});

test("one lost-answer table: an abort is not a lost answer for classifyError either", () => {
  assert.equal(classifyError(Object.assign(new Error("aborted"), { name: "AbortError", code: "ABORT_ERR" })), "internal_error");
  assert.equal(classifyError(Object.assign(new Error("t"), { code: "ETIMEDOUT" })), "no_answer");
});

test("a conflict without state says only that the version is in the JSON", () => {
  const r = conflict({ id: "n-1", currentVersion: 4, readWith: RW });
  assert.match(text(r), /^Its current version is in the JSON below\.$/m);
  assert.doesNotMatch(text(r), /current state/);
});
