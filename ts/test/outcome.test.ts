import { test } from "node:test";
import assert from "node:assert/strict";
import { unknownOutcome, guardWrite, classifyError, NotAppliedError, OutcomeUnknownError, applied, readResult } from "../src/index.js";

const text = (r: { content: Array<{ type: string; text?: unknown }> }) => String(r.content[0]!.text);
const rw = { tool: "get_note", arguments: { id: "n-3" } };

test("unknown outcome: error, code no_answer, read_first with read_with, no invitation to repeat blind", () => {
  const r = unknownOutcome({ summary: `the update to note "n-3" was sent and no answer arrived`, readWith: rw, object: { type: "note", id: "n-3" }, message: "timeout after 30 s" });
  assert.equal(r.isError, true);
  assert.deepEqual(r.structuredContent, { mws: { shape: "write-result/0.1", outcome: "unknown", repeat: "read_first", object: { type: "note", id: "n-3" }, code: "no_answer", message: "timeout after 30 s", read_with: rw } });
  const t = text(r);
  assert.match(t, /^Outcome unknown: the update to note "n-3" was sent and no answer arrived\. It is not known whether the change was applied\./);
  assert.match(t, /Before writing again, read it with "get_note" and the arguments \{"id":"n-3"\}/);
  assert.doesNotMatch(t, /try again|please retry|can be sent again/i);
});

test("unknown outcome with a key: same_key; with a version: same_version", () => {
  const k = unknownOutcome({ summary: "the create was sent", readWith: rw, guard: { idempotencyKey: { arg: "idempotency_key", value: "k-123456" } } });
  assert.equal(readResult(k)!.repeat, "same_key");
  assert.match(text(k), /only with the same idempotency_key "k-123456"/);
  const v = unknownOutcome({ summary: "the update was sent", readWith: rw, guard: { version: { arg: "expected_version", value: 4 } } });
  assert.equal(readResult(v)!.repeat, "same_version");
  assert.equal(readResult(v)!.version_argument, "expected_version");
  assert.match(text(v), /only with the same expected_version 4/);
});

test("classifyError: refusals, unsent requests and the rest", () => {
  assert.equal(classifyError(new NotAppliedError("refused")), "refused");
  assert.equal(classifyError(Object.assign(new Error("x"), { code: "ECONNREFUSED" })), "not_sent");
  assert.equal(classifyError(new TypeError("fetch failed", { cause: Object.assign(new Error("y"), { code: "ENOTFOUND" }) })), "not_sent");
  assert.equal(classifyError(Object.assign(new Error("x"), { code: "ECONNRESET" })), "no_answer");
  assert.equal(classifyError(Object.assign(new Error("x"), { code: "ETIMEDOUT" })), "no_answer");
  assert.equal(classifyError(Object.assign(new Error("aborted"), { name: "TimeoutError" })), "no_answer");
  assert.equal(classifyError(new OutcomeUnknownError("lost")), "no_answer");
  assert.equal(classifyError(new Error("something else")), "internal_error");
});

test("guardWrite passes a result through", async () => {
  const ok = applied({ summary: "done" });
  assert.equal(await guardWrite(async () => ok, { readWith: rw, what: "x" }), ok);
});

test("guardWrite: a connection reset becomes no_answer and leaks nothing", async () => {
  const r = await guardWrite(async () => { throw Object.assign(new Error("socket hang up https://api.example/x?token=SECRET"), { code: "ECONNRESET" }); },
    { readWith: rw, what: `the update of note "n-1"`, object: { id: "n-1" } });
  const s = readResult(r)!;
  assert.equal(s.outcome, "unknown");
  assert.equal(s.code, "no_answer");
  assert.equal(s.message, "error code ECONNRESET");
  assert.doesNotMatch(JSON.stringify(r), /SECRET/);
});

test("guardWrite: a crash in the server is internal_error, never no_answer", async () => {
  const r = await guardWrite(async () => { throw new TypeError("x is undefined"); }, { readWith: rw, what: `the update of note "n-1"` });
  assert.deepEqual([readResult(r)!.outcome, readResult(r)!.code, readResult(r)!.repeat], ["unknown", "internal_error", "read_first"]);
  assert.match(text(r), /^Outcome unknown: the update of note "n-1" stopped on a fault in the server/);
});

test("guardWrite: a refused connection is not_sent and may be repeated", async () => {
  const r = await guardWrite(async () => { throw Object.assign(new Error("connect"), { code: "ECONNREFUSED" }); }, { readWith: rw, what: "w" });
  assert.deepEqual([readResult(r)!.outcome, readResult(r)!.code, readResult(r)!.repeat], ["not_applied", "not_sent", "yes"]);
});

test("guardWrite: a NotAppliedError keeps its message and code", async () => {
  const r = await guardWrite(async () => { throw new NotAppliedError(`notebook "x" is not empty`, { code: "not_empty" }); }, { readWith: rw, what: "w" });
  assert.match(text(r), /^Not applied: notebook "x" is not empty\./);
  assert.equal(readResult(r)!.code, "not_empty");
});
