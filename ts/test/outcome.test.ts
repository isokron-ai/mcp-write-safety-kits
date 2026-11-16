import { test } from "node:test";
import assert from "node:assert/strict";
import { unknownOutcome, guardWrite, classifyError, NotAppliedError, OutcomeUnknownError, applied, readResult } from "../src/index.js";

const text = (r: { content: Array<{ type: string; text?: unknown }> }) => String(r.content[0]!.text);

test("unknown outcome: error, names the read, does not invite a blind repeat", () => {
  const r = unknownOutcome({ summary: `the update to note "n-3" was sent and no answer arrived`, settleWith: "get_note", object: { id: "n-3" }, cause: "timeout after 30 s" });
  assert.equal(r.isError, true);
  assert.deepEqual(r.structuredContent, { mws: "result/v0", outcome: "unknown", safe_to_repeat: false, object: { id: "n-3" }, settle_with: "get_note" });
  const t = text(r);
  assert.match(t, /^Outcome unknown: the update to note "n-3" was sent and no answer arrived\. It is not known whether the change was applied\./);
  assert.match(t, /Settle it with "get_note"/);
  assert.match(t, /Do not send the same call again before reading with "get_note"/);
  assert.match(t, /Safe to repeat: no\./);
  assert.doesNotMatch(t, /try again|please retry/i);
});

test("unknown outcome with an idempotency key: safe to repeat with that key", () => {
  const r = unknownOutcome({ summary: "the create was sent", settleWith: "list_notes", guard: { idempotencyKey: { arg: "idempotency_key", value: "k-123456" } } });
  assert.equal(readResult(r)!.safe_to_repeat, true);
  assert.match(text(r), /same idempotency_key "k-123456" will not apply it twice/);
});

test("unknown outcome with a version: safe to repeat with that version", () => {
  const r = unknownOutcome({ summary: "the update was sent", settleWith: "get_note", guard: { version: { arg: "expected_version", value: 4 } } });
  assert.equal(readResult(r)!.safe_to_repeat, true);
  assert.match(text(r), /same expected_version 4 will not apply it twice/);
});

test("classifyError: refusals and unsent requests are not applied; everything else is unknown", () => {
  assert.equal(classifyError(new NotAppliedError("refused")), "not_applied");
  assert.equal(classifyError(Object.assign(new Error("x"), { code: "ECONNREFUSED" })), "not_applied");
  assert.equal(classifyError(new TypeError("fetch failed", { cause: Object.assign(new Error("y"), { code: "ENOTFOUND" }) })), "not_applied");
  assert.equal(classifyError(Object.assign(new Error("x"), { code: "ECONNRESET" })), "unknown");
  assert.equal(classifyError(Object.assign(new Error("x"), { code: "ETIMEDOUT" })), "unknown");
  assert.equal(classifyError(new OutcomeUnknownError("lost")), "unknown");
  assert.equal(classifyError(new Error("something else")), "unknown");
  assert.equal(classifyError("a string"), "unknown");
});

test("guardWrite passes a result through", async () => {
  const ok = applied({ summary: "done", object: { id: 1 } });
  assert.equal(await guardWrite(async () => ok, { settleWith: "get", what: "x" }), ok);
});

test("guardWrite: a connection reset becomes an unknown outcome naming the read", async () => {
  const r = await guardWrite(async () => { throw Object.assign(new Error("socket hang up https://api.example/x?token=SECRET"), { code: "ECONNRESET" }); },
    { settleWith: "get_note", what: `the update to note "n-1" was sent and no answer arrived`, object: { id: "n-1" } });
  assert.equal(readResult(r)!.outcome, "unknown");
  assert.match(text(r), /Cause: error code ECONNRESET/);
  assert.doesNotMatch(text(r), /SECRET/, "the raw error message is never copied into the result");
});

test("guardWrite: a refused connection is not applied", async () => {
  const r = await guardWrite(async () => { throw Object.assign(new Error("connect"), { code: "ECONNREFUSED" }); }, { settleWith: "g", what: "w" });
  assert.equal(readResult(r)!.outcome, "not_applied");
  assert.match(text(r), /request was not sent/);
});

test("guardWrite: a NotAppliedError keeps its message", async () => {
  const r = await guardWrite(async () => { throw new NotAppliedError(`notebook "x" is not empty`); }, { settleWith: "g", what: "w" });
  assert.match(text(r), /^Not applied: notebook "x" is not empty\./);
});
