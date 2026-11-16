import { test } from "node:test";
import assert from "node:assert/strict";
import { readOnlyHints, writeHints, annotationProblems, defineTool, ToolSet, UnknownToolError, applied, NotAppliedError, readResult, SchemaError } from "../src/index.js";

const text = (r: { content: Array<{ type: string; text?: unknown }> }) => String(r.content[0]!.text);

test("write hints start from the cautious values, all four explicit", () => {
  assert.deepEqual(writeHints(), { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
  assert.deepEqual(writeHints({ destructive: false, idempotent: true, openWorld: false }), { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false });
});

test("read hints: read-only, all four explicit", () => {
  assert.deepEqual(readOnlyHints(), { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true });
});

test("annotationProblems finds missing hints and write tools claiming read-only", () => {
  const tools = [
    { name: "a", inputSchema: { type: "object" as const }, annotations: writeHints() },
    { name: "b", inputSchema: { type: "object" as const } },
    { name: "c", inputSchema: { type: "object" as const }, annotations: readOnlyHints() },
  ];
  const p = annotationProblems(tools, ["a", "c"]);
  assert.ok(p.includes("b: readOnlyHint is not declared"));
  assert.ok(p.includes("b: destructiveHint is not declared"));
  assert.ok(p.includes("c: a write tool declares readOnlyHint true"));
  assert.ok(!p.some((x) => x.startsWith("a:")));
});

const echo = defineTool<{ n: number }>({
  kind: "write",
  name: "bump",
  description: "Bumps.",
  inputSchema: { type: "object", properties: { n: { type: "integer" } }, required: ["n"] },
  hints: { destructive: false },
  settleWith: "get",
  handler: async ({ n }) => {
    if (n === 0) throw new NotAppliedError("n must not be zero here");
    if (n < 0) throw Object.assign(new Error("reset"), { code: "ECONNRESET" });
    return applied({ summary: `bumped to ${n}`, object: { id: "x", version: n } });
  },
});

test("defineTool advertises a closed schema and explicit hints", () => {
  assert.equal(echo.definition.inputSchema.additionalProperties, false);
  assert.deepEqual(echo.definition.annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true });
  assert.deepEqual(annotationProblems([echo.definition], ["bump"]), []);
});

test("defineTool validates before the handler, and turns throws into truthful results", async () => {
  assert.match(text(await echo.call({ n: "1" })), /expected integer, got string "1"/);
  assert.equal(readResult(await echo.call({ n: 2 }))!.outcome, "applied");
  assert.match(text(await echo.call({ n: 0 })), /^Not applied: n must not be zero here/);
  const u = await echo.call({ n: -1 });
  assert.equal(readResult(u)!.outcome, "unknown");
  assert.equal(readResult(u)!.settle_with, "get");
});

test("a read tool's internal error is an error result that leaks nothing", async () => {
  const t = defineTool({ kind: "read", name: "r", description: "d", inputSchema: { type: "object", properties: {} }, handler: () => { throw new Error("db password=hunter2"); } });
  const r = await t.call({});
  assert.equal(r.isError, true);
  assert.doesNotMatch(text(r), /hunter2/);
});

test("defineTool refuses an unsupported schema at definition time", () => {
  assert.throws(() => defineTool({ kind: "read", name: "r", description: "d", inputSchema: { type: "object", properties: { a: { oneOf: [] } as never } }, handler: () => applied({ summary: "x" }) }), SchemaError);
});

test("ToolSet lists in order, knows its write tools, and refuses unknown names", async () => {
  const r = defineTool({ kind: "read", name: "get", description: "d", inputSchema: { type: "object", properties: {} }, handler: () => ({ content: [{ type: "text", text: "ok" }] }) });
  const set = new ToolSet([r, echo]);
  assert.deepEqual(set.list().tools.map((t) => t.name), ["get", "bump"]);
  assert.deepEqual(set.writeTools(), ["bump"]);
  await assert.rejects(set.call("nope", {}), UnknownToolError);
  assert.throws(() => new ToolSet([r, r]), /duplicate/);
});
