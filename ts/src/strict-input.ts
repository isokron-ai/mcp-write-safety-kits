// Strict inputs (MWS-IN-1, IN-2, IN-3, IN-4, IN-6, IN-7).
//
// A validator for a tool's own JSON Schema (its `inputSchema`): the schema the tool advertises is
// the schema it enforces. It refuses, and never converts or drops:
//
//   - a value of another type than the schema declares ("5" for an integer, "false" for a boolean,
//     null for an argument not typed null)                                    MWS-IN-1, IN-6
//   - an argument the schema does not define                                  MWS-IN-2, IN-7
//   - a value that breaks a declared constraint (required, enum, const, bounds, lengths, pattern,
//     multipleOf, item and property counts, uniqueItems)                      MWS-IN-3
//
// Every refusal is a tool execution error (`isError: true`) that names the argument, says what was
// expected and what was sent, and says that nothing was changed (MWS-IN-4). zod is not needed.
//
// The validator supports a fixed subset of JSON Schema, listed in SUPPORTED_KEYWORDS. A schema that
// uses any other keyword (anyOf, $ref, if/then, patternProperties, ...) is refused when the tool is
// defined, not at call time: a keyword the validator ignored would be a constraint the tool
// advertises and does not enforce.

import { notApplied, pointerOf, q, type Scalar } from "./result.js";
import type { CallToolResult } from "./types.js";

/** The JSON Schema subset the validator enforces. */
export interface JsonSchema {
  type?: JsonType | JsonType[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  enum?: unknown[];
  const?: unknown;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  multipleOf?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  minProperties?: number;
  maxProperties?: number;
  // Annotations: allowed, not enforced.
  title?: string;
  description?: string;
  default?: unknown;
  examples?: unknown[];
  format?: string;
  $schema?: string;
  $comment?: string;
  deprecated?: boolean;
  readOnly?: boolean;
  writeOnly?: boolean;
}

export type JsonType = "string" | "number" | "integer" | "boolean" | "object" | "array" | "null";

/** Keywords the validator enforces or knowingly ignores (annotations; `format` is an annotation by default in JSON Schema). */
export const SUPPORTED_KEYWORDS: readonly string[] = [
  "type", "properties", "required", "additionalProperties", "items", "enum", "const",
  "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
  "minLength", "maxLength", "pattern", "minItems", "maxItems", "uniqueItems", "minProperties", "maxProperties",
  "title", "description", "default", "examples", "format", "$schema", "$comment", "deprecated", "readOnly", "writeOnly",
];

const TYPES: readonly JsonType[] = ["string", "number", "integer", "boolean", "object", "array", "null"];

/** One refused argument. `path` is the argument's name, with nested parts (`details.severity`, `tags[2]`). */
export interface InputIssue {
  path: string;
  /** The same argument as a JSON Pointer into the arguments (`/details/severity`, `/tags/2`). */
  pointer: string;
  /** What was wrong, in one clause: `expected integer, got string "5"`. */
  reason: string;
  /** What the schema expects. */
  expected: string;
  /** What was sent, quoted (JSON, cut at 80 characters), or "nothing" for a missing argument. */
  sent: string;
}

export type Validation = { ok: true; value: Record<string, unknown> } | { ok: false; issues: InputIssue[]; result: CallToolResult };

/** Thrown when a schema uses a keyword outside the supported subset, or is malformed. */
export class SchemaError extends Error {
  override readonly name = "SchemaError";
}

function jsonTypeOf(v: unknown): JsonType | "undefined" | "other" {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  switch (typeof v) {
    case "string": return "string";
    case "boolean": return "boolean";
    case "number": return Number.isFinite(v) ? (Number.isInteger(v) ? "integer" : "number") : "other";
    case "object": return "object";
    case "undefined": return "undefined";
    default: return "other";
  }
}

function shown(v: unknown): string {
  if (v === undefined) return "nothing";
  let s: string;
  try {
    s = JSON.stringify(v) ?? String(v);
  } catch {
    s = String(v);
  }
  return s.length > 80 ? `${s.slice(0, 77)}...` : s;
}

function typeName(v: unknown): string {
  const t = jsonTypeOf(v);
  return t === "integer" ? "number" : t;
}

function join(path: string, key: string | number): string {
  if (typeof key === "number") return `${path}[${key}]`;
  return path ? `${path}.${key}` : key;
}

/** Deep equality for JSON values (enum, const, uniqueItems). */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((x, i) => jsonEqual(x, bb[i]));
  }
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && jsonEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length]![b.length]!;
}

function nearest(name: string, known: string[]): string | undefined {
  let best: string | undefined;
  let bestD = 3;
  for (const k of known) {
    const dist = editDistance(name.toLowerCase(), k.toLowerCase());
    if (dist < bestD) [best, bestD] = [k, dist];
  }
  return best;
}

/**
 * Checks that a schema uses only supported keywords and well-formed values. Throws SchemaError,
 * naming the keyword and where it is.
 */
export function assertSupportedSchema(schema: JsonSchema, at = "inputSchema"): void {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) throw new SchemaError(`${at} is not a schema object`);
  for (const k of Object.keys(schema)) {
    if (!SUPPORTED_KEYWORDS.includes(k)) {
      throw new SchemaError(`${at} uses the keyword ${q(k)}, which this validator does not enforce. Supported: ${SUPPORTED_KEYWORDS.join(", ")}.`);
    }
  }
  const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  for (const t of types) if (!TYPES.includes(t)) throw new SchemaError(`${at}.type: ${q(t)} is not a JSON Schema type`);
  if (schema.pattern !== undefined) {
    try {
      new RegExp(schema.pattern, "u");
    } catch (e) {
      throw new SchemaError(`${at}.pattern is not a valid regular expression: ${(e as Error).message}`);
    }
  }
  if (schema.multipleOf !== undefined && !(schema.multipleOf > 0)) throw new SchemaError(`${at}.multipleOf must be greater than 0`);
  if (schema.properties) for (const [k, s] of Object.entries(schema.properties)) assertSupportedSchema(s, `${at}.properties.${k}`);
  if (schema.items) assertSupportedSchema(schema.items, `${at}.items`);
  for (const r of schema.required ?? []) {
    if (!schema.properties || !Object.prototype.hasOwnProperty.call(schema.properties, r)) {
      throw new SchemaError(`${at}.required names ${q(r)}, which is not in properties`);
    }
  }
}

/**
 * Returns a copy of the schema with `additionalProperties: false` written at every object level
 * that does not set it, so that the advertised schema says what the validator does: an argument it
 * does not define is refused (MWS-IN-2, IN-7 guidance). A level that sets it to true is kept; that
 * is how a free-form object is declared.
 */
export function closeSchema(schema: JsonSchema): JsonSchema {
  const out: JsonSchema = { ...schema };
  const types = out.type === undefined ? [] : Array.isArray(out.type) ? out.type : [out.type];
  if (out.properties) out.properties = Object.fromEntries(Object.entries(out.properties).map(([k, s]) => [k, closeSchema(s)]));
  if ((out.properties || types.includes("object")) && out.additionalProperties === undefined) out.additionalProperties = false;
  if (out.items) out.items = closeSchema(out.items);
  return out;
}

function typeMatches(t: JsonType, actual: ReturnType<typeof jsonTypeOf>): boolean {
  return t === actual || (t === "number" && actual === "integer");
}

function checkValue(schema: JsonSchema, value: unknown, path: string, segs: Array<string | number>, issues: InputIssue[]): void {
  const ptr = pointerOf(segs);
  const add = (reason: string, expected: string) => issues.push({ path, pointer: ptr, reason, expected, sent: shown(value) });
  const actual = jsonTypeOf(value);
  if (schema.type !== undefined) {
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!allowed.some((t) => typeMatches(t, actual))) {
      const expected = allowed.join(" or ");
      const got = value === null ? "null" : `${typeName(value)} ${shown(value)}`;
      add(`expected ${expected}, got ${got}`, expected);
      return;
    }
  } else if (actual === "other" || actual === "undefined") {
    add(`expected a JSON value, got ${shown(value)}`, "a JSON value");
    return;
  }
  if (schema.enum !== undefined && !schema.enum.some((e) => jsonEqual(e, value))) {
    const expected = `one of ${schema.enum.map(shown).join(", ")}`;
    add(`must be ${expected}; got ${shown(value)}`, expected);
  }
  if (schema.const !== undefined && !jsonEqual(schema.const, value)) add(`must be ${shown(schema.const)}; got ${shown(value)}`, shown(schema.const));
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) add(`must be at least ${schema.minimum}; got ${value}`, `a number at least ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) add(`must be at most ${schema.maximum}; got ${value}`, `a number at most ${schema.maximum}`);
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) add(`must be greater than ${schema.exclusiveMinimum}; got ${value}`, `a number greater than ${schema.exclusiveMinimum}`);
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) add(`must be less than ${schema.exclusiveMaximum}; got ${value}`, `a number less than ${schema.exclusiveMaximum}`);
    if (schema.multipleOf !== undefined) {
      const r = value / schema.multipleOf;
      if (Math.abs(r - Math.round(r)) > 1e-9) add(`must be a multiple of ${schema.multipleOf}; got ${value}`, `a multiple of ${schema.multipleOf}`);
    }
  }
  if (typeof value === "string") {
    const len = [...value].length;
    if (schema.minLength !== undefined && len < schema.minLength) add(`must be at least ${schema.minLength} characters; got ${len}`, `a string of at least ${schema.minLength} characters`);
    if (schema.maxLength !== undefined && len > schema.maxLength) add(`must be at most ${schema.maxLength} characters; got ${len}`, `a string of at most ${schema.maxLength} characters`);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, "u").test(value)) add(`must match the pattern ${q(schema.pattern)}; got ${shown(value)}`, `a string matching ${q(schema.pattern)}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) add(`must have at least ${schema.minItems} items; got ${value.length}`, `at least ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) add(`must have at most ${schema.maxItems} items; got ${value.length}`, `at most ${schema.maxItems} items`);
    if (schema.uniqueItems) {
      const dup = value.findIndex((x, i) => value.slice(0, i).some((y) => jsonEqual(x, y)));
      if (dup >= 0) add(`must not repeat an item; ${shown(value[dup])} is repeated`, "items without repeats");
    }
    if (schema.items) value.forEach((item, i) => checkValue(schema.items!, item, join(path, i), [...segs, i], issues));
  }
  if (actual === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (schema.minProperties !== undefined && keys.length < schema.minProperties) add(`must have at least ${schema.minProperties} properties; got ${keys.length}`, `at least ${schema.minProperties} properties`);
    if (schema.maxProperties !== undefined && keys.length > schema.maxProperties) add(`must have at most ${schema.maxProperties} properties; got ${keys.length}`, `at most ${schema.maxProperties} properties`);
    const props = schema.properties ?? {};
    const known = Object.keys(props);
    for (const k of keys) {
      if (Object.prototype.hasOwnProperty.call(props, k)) checkValue(props[k]!, obj[k], join(path, k), [...segs, k], issues);
      else if (schema.additionalProperties !== true) {
        const near = nearest(k, known);
        issues.push({
          path: join(path, k),
          pointer: pointerOf([...segs, k]),
          reason: `is not an argument of this tool${near ? ` (did you mean ${q(near)}?)` : ""}`,
          expected: known.length ? `one of the defined arguments ${known.map((x) => q(x)).join(", ")}` : "no arguments",
          sent: shown(obj[k]),
        });
      }
    }
    for (const r of schema.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(obj, r)) {
        const s = props[r];
        const expected = s?.type ? (Array.isArray(s.type) ? s.type.join(" or ") : s.type) : "a value";
        issues.push({ path: join(path, r), pointer: pointerOf([...segs, r]), reason: "is required and was not sent", expected, sent: "nothing" });
      }
    }
  }
}

/** Validates arguments against a schema. Returns the issues; an empty list means the arguments are valid. */
export function validateArguments(schema: JsonSchema, args: unknown): InputIssue[] {
  const issues: InputIssue[] = [];
  checkValue(schema, args === undefined ? {} : args, "", [], issues);
  return issues;
}

/** The sentence for one issue: `argument "priority": expected integer, got string "5"`. */
export function describeIssue(i: InputIssue): string {
  return i.path ? `argument ${q(i.path)} ${i.reason.startsWith("is ") ? i.reason : `was refused: ${i.reason}`}` : `the arguments were refused: ${i.reason}`;
}

/** Options for inputError. */
export interface InputErrorOptions {
  /** Default "invalid_argument"; "version_required" for a missing version (NF-3). */
  code?: string;
  object?: { type?: string; id?: Scalar };
  operation?: string;
}

/**
 * The tool execution error for refused arguments (MWS-IN-4): `outcome: "not_applied"`, `code:
 * "invalid_argument"`, `argument` a JSON Pointer to the first refused argument, and a text that
 * names each argument, what was expected and what was sent.
 */
export function inputError(issues: InputIssue[], o: InputErrorOptions = {}): CallToolResult {
  const [first, ...rest] = issues;
  const summary = first ? describeIssue(first) : "the arguments were refused";
  return notApplied({
    summary,
    code: o.code ?? "invalid_argument",
    argument: first?.pointer,
    message: `${summary.charAt(0).toUpperCase()}${summary.slice(1)}.`,
    object: o.object,
    operation: o.operation,
    repeat: "no",
    notes: [
      ...rest.map((i) => `Also: ${describeIssue(i)}`),
      ...issues.map((i) => `Argument ${q(i.path || "(arguments)")}: expected ${i.expected}; sent ${i.sent}`),
      "Correct the arguments before calling again",
    ],
  });
}

/** A compiled strict input: the schema to advertise and the check to run on every call. */
export interface StrictInput {
  /** The schema to advertise in tools/list, with additionalProperties: false written out. */
  readonly schema: JsonSchema & { type: "object" };
  /** Validates a call's arguments. */
  validate(args: unknown): Validation;
}

/**
 * Compiles a tool's input schema for strict validation. Throws SchemaError for a keyword the
 * validator does not enforce, or for a top level that is not `type: "object"`.
 */
export function strictInput(schema: JsonSchema): StrictInput {
  if (schema.type !== "object") throw new SchemaError(`inputSchema.type must be "object"`);
  assertSupportedSchema(schema);
  const closed = closeSchema(schema) as JsonSchema & { type: "object" };
  return {
    schema: closed,
    validate(args) {
      const issues = validateArguments(closed, args);
      if (issues.length) return { ok: false, issues, result: inputError(issues) };
      return { ok: true, value: (args ?? {}) as Record<string, unknown> };
    },
  };
}

/**
 * Wraps a handler so that it runs only with valid arguments; any refusal is returned as the input
 * error, and the handler is not called (nothing is changed).
 */
export function withStrictInput<A extends Record<string, unknown>, R>(
  schema: JsonSchema,
  handler: (args: A) => R | Promise<R>,
): { schema: JsonSchema & { type: "object" }; handler: (args: unknown) => Promise<R | CallToolResult> } {
  const s = strictInput(schema);
  return {
    schema: s.schema,
    async handler(args: unknown) {
      const v = s.validate(args);
      if (!v.ok) return v.result;
      return handler(v.value as A);
    },
  };
}
