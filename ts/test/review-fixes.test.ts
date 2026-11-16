// Regression tests for the pre-release review: B-9 rules the builders enforce, the text mirror,
// error codes, key-store limits and schema checks.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applied, accepted, notApplied, itemsResult, conflict, guardWrite, unknownCode, OutcomeUnknownError,
  MemoryIdempotencyStore, withIdempotency, strictInput, validateArguments, SchemaError, q, type CallToolResult,
} from "../src/index.js";

const RW = { tool: "get_note", arguments: { id: "n-1" } };
const mws = (r: CallToolResult) => (r.structuredContent as Record<string, Record<string, unknown>>)["mws"]!;
const text = (r: CallToolResult) => String((r.content[0] as { text: string }).text);

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
  assert.throws(() => itemsResult({ summary: "x", items }), /read_first/);
  assert.equal(mws(itemsResult({ summary: "x", items, object: { id: "nb-1" } }))["repeat"], "read_first");
});

test("repeat yes after an applied delete is refused", () => {
  assert.throws(() => applied({ summary: "deleted", operation: "delete", repeat: "yes" }), /delete/);
});

test("same_key and same_version need the key or version the call carried", () => {
  assert.throws(() => notApplied({ summary: "x", repeat: "same_key" }), /same_key/);
  assert.throws(() => notApplied({ summary: "x", repeat: "same_version" }), /same_version/);
  assert.equal(mws(notApplied({ summary: "x", repeat: "same_key", key: "k-12345678", keyArgument: "idempotency_key" }))["repeat"], "same_key");
});

test("an open item is never under applied or not_applied", () => {
  assert.throws(() => notApplied({ summary: "x", items: [{ index: 0, outcome: "unknown" }] }), /open outcome/);
  assert.throws(() => notApplied({ summary: "x", items: [{ index: 0, outcome: "applied" }] }), /partial/);
});

test("a null or empty current version is left out, not written as a placeholder", () => {
  for (const v of [null, ""]) {
    const r = conflict({ id: "n-1", currentVersion: v as unknown as string, currentState: { t: 1 }, readWith: RW });
    const c = mws(r)["conflict"] as Record<string, unknown>;
    assert.equal(c["current_version"], undefined);
    assert.equal(c["version_source"], undefined);
    assert.doesNotMatch(text(r), /version null/);
  }
});

test("no_answer only where the error shows a lost answer", async () => {
  assert.equal(unknownCode(Object.assign(new Error("t"), { code: "ETIMEDOUT" })), "no_answer");
  assert.equal(unknownCode(new OutcomeUnknownError("timeout after 30 s")), "no_answer");
  assert.equal(unknownCode(new TypeError("x is undefined")), "internal_error");
  const r = await guardWrite(async () => { throw new TypeError("bug"); }, { readWith: RW, what: "sent, no answer", whatOnError: "stopped with an error" });
  assert.equal(mws(r)["outcome"], "unknown");
  assert.equal(mws(r)["code"], "internal_error");
  assert.match(text(r), /stopped with an error/);
});

test("a full key store refuses a new key and never drops a live one", async () => {
  const store = new MemoryIdempotencyStore({ maxEntries: 2 });
  let writes = 0;
  const call = (key: string, fail = false) => withIdempotency({ store, scope: "s", args: { idempotency_key: key }, readWith: RW }, async () => {
    writes++;
    if (fail) throw Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
    return applied({ summary: `wrote ${q(key)}` });
  });
  await assert.rejects(call("key-lost-1", true));
  await call("key-ok-0001");
  const full = await call("key-ok-0002");
  assert.equal(mws(full)["code"], "key_store_full");
  assert.equal(mws(full)["outcome"], "not_applied");
  const again = await call("key-lost-1", true);
  assert.equal(mws(again)["outcome"], "unknown");
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
