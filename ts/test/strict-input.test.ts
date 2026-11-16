import { test } from "node:test";
import assert from "node:assert/strict";
import { strictInput, validateArguments, closeSchema, SchemaError, withStrictInput, readResult, type JsonSchema } from "../src/index.js";

const text = (r: { content: Array<{ type: string; text?: unknown }> }) => String(r.content[0]!.text);

const schema: JsonSchema & { type: "object" } = {
  type: "object",
  properties: {
    id: { type: "string", minLength: 1 },
    assignee: { type: ["string", "null"] },
    priority: { type: "integer", minimum: 1, maximum: 5 },
    ratio: { type: "number", exclusiveMinimum: 0, exclusiveMaximum: 1, multipleOf: 0.25 },
    archived: { type: "boolean" },
    status: { type: "string", enum: ["open", "closed"] },
    kind: { const: "note" },
    tags: { type: "array", items: { type: "string", pattern: "^[a-z]+$" }, minItems: 1, maxItems: 3, uniqueItems: true },
    details: { type: "object", properties: { severity: { type: "string" } }, minProperties: 1, maxProperties: 1 },
  },
  required: ["id"],
};

const s = strictInput(schema);
const issues = (args: unknown) => validateArguments(s.schema, args);

test("valid arguments pass unchanged (no coercion, no defaults)", () => {
  const args = { id: "a", priority: 3, archived: false, status: "open", tags: ["x", "y"], assignee: null, ratio: 0.5, kind: "note", details: { severity: "high" } };
  const v = s.validate(args);
  assert.ok(v.ok);
  assert.equal(v.ok && v.value, args);
});

test("advertised schema closes every object level", () => {
  assert.equal(s.schema.additionalProperties, false);
  assert.equal(s.schema.properties!.details!.additionalProperties, false);
  assert.equal(closeSchema({ type: "object", properties: {}, additionalProperties: true }).additionalProperties, true);
});

test("MWS-IN-1 probe list v1: every wrongly typed value is refused, never converted", () => {
  const probes: Array<[string, unknown]> = [
    ["archived", "false"], ["archived", "true"], ["archived", "yes"], ["archived", 0], ["archived", 1], ["archived", null],
    ["priority", "5"], ["priority", "abc"], ["priority", ""], ["priority", null], ["priority", true], ["priority", 0.5],
    ["id", 5], ["id", true], ["id", null], ["id", { a: 1 }], ["id", [1]], ["priority", { a: 1 }], ["archived", [1]],
  ];
  for (const [arg, value] of probes) {
    const v = s.validate({ id: "a", [arg]: value });
    assert.equal(v.ok, false, `${arg}=${JSON.stringify(value)} must be refused`);
    if (!v.ok) {
      assert.equal(v.issues[0]!.path, arg);
      assert.equal(v.result.isError, true);
      const t = text(v.result);
      assert.ok(t.includes(`"${arg}"`), `names the argument: ${t}`);
      assert.match(t, /expected (integer|boolean|string)/);
      assert.match(t, /Nothing was changed\./);
    }
  }
});

test("a type error says what was expected and what was sent", () => {
  const v = s.validate({ id: "a", priority: "5" });
  assert.ok(!v.ok);
  const t = text(v.result);
  assert.match(t, /^Not applied: argument "priority" was refused: expected integer, got string "5"\. Nothing was changed\./);
  assert.match(t, /Argument "priority": expected integer; sent "5"/);
  assert.equal(readResult(v.result)!.outcome, "not_applied");
});

test("MWS-IN-2 / IN-7: an unknown argument is refused, naming it and the nearest real one", () => {
  const v = s.validate({ id: "a", asignee: "bob" });
  assert.ok(!v.ok);
  assert.match(text(v.result), /argument "asignee" is not an argument of this tool \(did you mean "assignee"\?\)/);
  const w = s.validate({ id: "a", zzzzzz: 1 });
  assert.ok(!w.ok);
  assert.doesNotMatch(text(w.result), /did you mean/);
  assert.ok(issues({ id: "a", details: { severity: "x", extra: 1 } }).some((i) => i.path === "details.extra"));
});

test("MWS-IN-3: every declared constraint is enforced", () => {
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{}, /"id" is required and was not sent/],
    [{ id: "" }, /at least 1 characters/],
    [{ id: "a", priority: 0 }, /at least 1/],
    [{ id: "a", priority: 6 }, /at most 5/],
    [{ id: "a", priority: -1e12 }, /at least 1/],
    [{ id: "a", ratio: 0 }, /greater than 0/],
    [{ id: "a", ratio: 1 }, /less than 1/],
    [{ id: "a", ratio: 0.3 }, /multiple of 0.25/],
    [{ id: "a", status: "archived" }, /one of "open", "closed"/],
    [{ id: "a", kind: "task" }, /must be "note"/],
    [{ id: "a", tags: [] }, /at least 1 items/],
    [{ id: "a", tags: ["a", "b", "c", "d"] }, /at most 3 items/],
    [{ id: "a", tags: ["a", "a"] }, /must not repeat/],
    [{ id: "a", tags: ["A"] }, /must match the pattern/],
    [{ id: "a", details: {} }, /at least 1 properties/],
  ];
  for (const [args, re] of cases) {
    const v = s.validate(args);
    assert.ok(!v.ok, JSON.stringify(args));
    if (!v.ok) assert.match(text(v.result), re);
  }
});

test("nested paths are named", () => {
  assert.equal(issues({ id: "a", tags: ["ok", 5] })[0]!.path, "tags[1]");
});

test("lengths count code points", () => {
  const t = strictInput({ type: "object", properties: { s: { type: "string", maxLength: 2 } } });
  assert.ok(t.validate({ s: "\u{1F600}\u{1F600}" }).ok);
});

test("missing arguments object is treated as {}", () => {
  const t = strictInput({ type: "object", properties: {} });
  assert.ok(t.validate(undefined).ok);
  assert.ok(!t.validate({ x: 1 }).ok);
  assert.ok(!t.validate([]).ok);
});

test("an unsupported keyword is refused when the tool is defined", () => {
  assert.throws(() => strictInput({ type: "object", properties: { a: { anyOf: [] } as never } }), SchemaError);
  assert.throws(() => strictInput({ type: "object", properties: { a: { $ref: "#/x" } as never } }), /\$ref/);
  assert.throws(() => strictInput({ type: "object", properties: {}, required: ["x"] }), /not in properties/);
  assert.throws(() => strictInput({ type: "object", properties: { a: { type: "string", pattern: "(" } } }), /pattern/);
  assert.throws(() => strictInput({ type: "string" } as never), /must be "object"/);
});

test("withStrictInput does not call the handler on a refusal", async () => {
  let calls = 0;
  const w = withStrictInput({ type: "object", properties: { n: { type: "integer" } } }, (a: { n?: number }) => { calls++; return a.n; });
  const bad = await w.handler({ n: "1" });
  assert.equal(calls, 0);
  assert.equal((bad as { isError?: boolean }).isError, true);
  assert.equal(await w.handler({ n: 1 }), 1);
  assert.equal(calls, 1);
});
