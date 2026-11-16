// The write-result shape, version 0.1 (MWS 0.9, Annex B, B-9), and the builders that produce it.
//
// The shape is the member `mws` of `structuredContent`; the tool's own output, if any, sits beside
// it. Every result also says in text what the shape says: the first text block is generated from
// the shape (a plain sentence that opens with the outcome, never restating `current_state`), and
// the second is exactly `JSON.stringify(structuredContent)` (MWS-RES-1, RES-2, RES-4, ATOM-1,
// CONC-4, CONC-6). Every result is checked against the shape's rules before it is returned; a
// result that fails the check is replaced by an `internal_error` result (fail closed).

import type { CallToolResult } from "./types.js";

/** The shape's name. */
export const SHAPE_NAME = "write-result" as const;
/** The version this kit writes and reads. */
export const SHAPE_VERSION = "0.1" as const;
/** The value of `mws.shape`. */
export const SHAPE = `${SHAPE_NAME}/${SHAPE_VERSION}` as const;

/** What the write did, as a whole. */
export type Outcome = "applied" | "not_applied" | "partial" | "unknown" | "accepted";
/** Whether, and how, the same call may be sent again. */
export type Repeat = "no" | "yes" | "same_key" | "same_version" | "read_first";
/** The outcome of one item or step. */
export type ItemOutcome = "applied" | "not_applied" | "not_attempted" | "unknown";

/** The 13 codes that version 0.1 reserves, each with the outcome it implies. A server may define others. */
export const RESERVED_CODES = {
  conflict: "not_applied",
  locked: "not_applied",
  version_required: "not_applied",
  invalid_argument: "not_applied",
  not_found: "not_applied",
  idempotency_key_reused: "not_applied",
  in_progress: "unknown",
  key_not_known: "unknown",
  unavailable: "not_applied",
  not_sent: "not_applied",
  no_answer: "unknown",
  backend_error: "unknown",
  internal_error: "unknown",
} as const satisfies Record<string, Outcome>;
export type ReservedCode = keyof typeof RESERVED_CODES;

/**
 * An identifier or a version: a string or an integer, in the JSON type the write tool's argument
 * for it accepts (otherwise as the read tool returns it), so that a caller can pass it on unchanged.
 */
export type Idv = string | number;
/** The same as Idv (kept for callers of the earlier draft). */
export type Scalar = Idv;

/** An object inside which another was written (a ticket for a comment). */
export interface ParentRef {
  type?: string;
  id?: Idv;
  version?: Idv;
}

/** The object written. */
export interface ObjectRef {
  type?: string;
  id?: Idv;
  version?: Idv;
  /** The scope it was written in, as the tool's scope argument names it. */
  scope?: string;
  parent?: ParentRef;
}

/** The state a write was refused against. */
export interface Conflict {
  current_version?: Idv;
  /** "backend" where the backend's own check refused the write (B-2), "server" where the server compared (B-3). */
  checked_by?: "backend" | "server";
  current_state?: Record<string, unknown>;
  omitted?: string[];
  held_by?: string;
}

/** One item or step of a write of several. At least one of index, step and id is present. */
export interface Item {
  index?: number;
  step?: string;
  id?: Idv;
  version?: Idv;
  outcome: ItemOutcome;
  code?: string;
  message?: string;
  conflict?: Conflict;
}

/** One refused argument. */
export interface ArgumentError {
  argument: string;
  code?: string;
  message?: string;
}

/** A read that shows the object's current state. */
export interface ReadWith {
  tool: string;
  arguments: Record<string, unknown>;
}

/** The write-result shape, version 0.1. `shape` and `outcome` are required; every other member is optional. */
export interface WriteResult {
  shape: typeof SHAPE;
  outcome: Outcome;
  repeat?: Repeat;
  operation?: string;
  object?: ObjectRef;
  changed?: string[];
  replayed?: true;
  items?: Item[];
  applied_count?: number;
  code?: string;
  message?: string;
  argument?: string;
  argument_errors?: ArgumentError[];
  conflict?: Conflict;
  read_with?: ReadWith;
  version_argument?: string;
}

/** The value of `isError` each outcome implies (B-9, the outcome table). */
export function isErrorFor(outcome: Outcome): boolean {
  return outcome === "not_applied" || outcome === "partial" || outcome === "unknown";
}

/** Quotes a value for a sentence: every value as JSON, so each can be read only one way. */
export function q(value: unknown): string {
  return JSON.stringify(value) ?? "null";
}

/**
 * A JSON Pointer (RFC 6901) for a top-level field name. A value that already starts with "/" is
 * kept, and "" (the whole object) stays "".
 */
export function pointer(field: string): string {
  if (field === "" || field.startsWith("/")) return field;
  return `/${field.replace(/~/g, "~0").replace(/\//g, "~1")}`;
}

/** A JSON Pointer from path segments: pointerOf(["tags", 2]) is "/tags/2". "" for no segments. */
export function pointerOf(segments: Array<string | number>): string {
  return segments.map((s) => `/${String(s).replace(/~/g, "~0").replace(/\//g, "~1")}`).join("");
}

// null and "" are treated as absent: B-9 never gives a member as null or a placeholder.
const present = <T>(v: T | null | undefined): T | undefined => (v === null || v === "" ? undefined : v ?? undefined);

function clean<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

const CODE = /^[a-z0-9_]+$/;
const MAX_INT = Number.MAX_SAFE_INTEGER;
const OUTCOMES: readonly Outcome[] = ["applied", "not_applied", "partial", "unknown", "accepted"];
const REPEATS: readonly Repeat[] = ["no", "yes", "same_key", "same_version", "read_first"];
const ITEM_OUTCOMES: readonly ItemOutcome[] = ["applied", "not_applied", "not_attempted", "unknown"];
const isIdv = (v: unknown): v is Idv => typeof v === "string" || (Number.isInteger(v) && Math.abs(v as number) <= MAX_INT);
const isPtr = (v: unknown): v is string => typeof v === "string" && (v === "" || v.startsWith("/"));

/**
 * Checks a shape before it is returned. Throws a TypeError naming the first rule broken: a value
 * out of its list or of the wrong type, or a combination B-9 rules out.
 */
export function assertShape(r: WriteResult): void {
  const fail = (m: string): never => {
    throw new TypeError(`write-result/0.1: ${m}`);
  };
  if (r.shape !== SHAPE) fail(`shape must be ${q(SHAPE)}`);
  if (!OUTCOMES.includes(r.outcome)) fail(`outcome ${q(r.outcome)} is not one of ${OUTCOMES.map(q).join(", ")}`);
  if (r.repeat !== undefined && !REPEATS.includes(r.repeat)) fail(`repeat ${q(r.repeat)} is not one of ${REPEATS.map(q).join(", ")}`);
  if (r.repeat === "yes" && r.outcome !== "not_applied") fail(`repeat "yes" is used only with outcome "not_applied"`);
  if (r.code !== undefined) {
    if (!CODE.test(r.code)) fail(`code ${q(r.code)} must be lowercase letters, digits and underscores`);
    const implied = (RESERVED_CODES as Record<string, Outcome>)[r.code];
    if (implied && implied !== r.outcome) fail(`code ${q(r.code)} goes with outcome ${q(implied)}, not ${q(r.outcome)}`);
  }
  if (r.code === "conflict" && r.repeat !== "read_first") fail(`a conflict has repeat "read_first"`);
  for (const v of [r.object?.id, r.object?.version, r.object?.parent?.id, r.object?.parent?.version, r.conflict?.current_version]) {
    if (v !== undefined && !isIdv(v)) fail(`${q(v)} is not an identifier or version (a string, or an integer within 2^53-1)`);
  }
  if (r.repeat === "read_first" && !r.read_with && !r.object?.id) {
    fail(`repeat "read_first" names a read only with read_with or object.id: give readWith`);
  }
  if (r.object?.scope !== undefined && typeof r.object.scope !== "string") fail("object.scope must be a string");
  if (r.outcome === "not_applied" && r.object?.version !== undefined) fail("on a refusal, object.version is left out (the current version goes in conflict.current_version)");
  if (r.outcome === "accepted" && (r.changed !== undefined || r.object?.version !== undefined)) fail("accepted leaves out changed and object.version");
  for (const it of r.items ?? []) {
    if (it.index === undefined && it.step === undefined && it.id === undefined) fail("an item has index, step or id");
    if (it.index !== undefined && (!Number.isInteger(it.index) || it.index < 0)) fail("items[].index must be an integer from 0");
    if (!ITEM_OUTCOMES.includes(it.outcome)) fail(`items[].outcome ${q(it.outcome)} is not one of ${ITEM_OUTCOMES.map(q).join(", ")}`);
    if (it.code !== undefined && !CODE.test(it.code)) fail(`items[].code ${q(it.code)} must be lowercase letters, digits and underscores`);
    for (const v of [it.id, it.version, it.conflict?.current_version]) if (v !== undefined && !isIdv(v)) fail(`${q(v)} is not an identifier or version`);
  }
  if (r.outcome === "applied" || r.outcome === "not_applied") {
    const outs = (r.items ?? []).map((i) => i.outcome);
    if (outs.includes("unknown")) fail(`an item with an open outcome makes the whole outcome unknown, not ${r.outcome}`);
    if (r.outcome === "not_applied" && outs.includes("applied")) fail("not_applied says no change is in effect; an applied item makes it partial");
  }
  for (const v of [r.conflict?.current_version, ...(r.items ?? []).map((i) => i.conflict?.current_version)]) {
    if (v === "") fail("conflict.current_version is never empty: leave it out where there is none");
  }
  if (r.applied_count !== undefined && (!Number.isInteger(r.applied_count) || r.applied_count < 0)) fail("applied_count must be a non-negative integer");
  if (r.conflict && r.code !== "conflict" && r.code !== "locked") fail(`conflict is present only where code is "conflict" or "locked"`);
  for (const p of [...(r.changed ?? []), ...(r.conflict?.omitted ?? []), ...(r.argument !== undefined ? [r.argument] : []), ...(r.argument_errors ?? []).map((e) => e.argument)]) {
    if (!isPtr(p)) fail(`${q(p)} is not a JSON Pointer`);
  }
  for (const e of r.argument_errors ?? []) if (e.code !== undefined && !CODE.test(e.code)) fail(`argument_errors[].code ${q(e.code)} must be lowercase letters, digits and underscores`);
  if (r.read_with && (typeof r.read_with.tool !== "string" || typeof r.read_with.arguments !== "object" || r.read_with.arguments === null || Array.isArray(r.read_with.arguments))) {
    fail("read_with needs tool (a string) and arguments (an object)");
  }
}

// ---------------------------------------------------------------------------------------------
// Text

const HEADLINE: Record<Outcome, string> = {
  applied: "Applied",
  not_applied: "Not applied",
  partial: "Partly applied",
  unknown: "Outcome unknown",
  accepted: "Accepted",
};

function sentence(s: string): string {
  const t = s.trim();
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

/** Options for the first text block. */
export interface TextOptions {
  /**
   * One plain sentence about the write, without a final period, e.g. `updated note "n-3"`. It
   * follows the opening words ("Applied:", "Not applied:", ...). Quote every value in it (`q()`).
   */
  summary: string;
  /** Further sentences, after the fixed ones. */
  notes?: string[];
  /** The argument that carries an idempotency key, for the sentence on `repeat: "same_key"`. */
  keyArgument?: string;
  /** The key the call carried, for the same sentence. */
  key?: string;
  /** The version the call carried, for the sentence on `repeat: "same_version"`. */
  sentVersion?: Idv;
}

function readSentence(r: WriteResult): string | null {
  if (!r.read_with) return null;
  return `read it with ${q(r.read_with.tool)} and the arguments ${JSON.stringify(r.read_with.arguments)}`;
}

/**
 * Renders the first text block from the shape: the outcome in plain words, the repeat instruction
 * and the read to make. It never restates `current_state`; the second block carries the JSON.
 */
export function renderText(r: WriteResult, o: TextOptions): string {
  const lines: string[] = [];
  const head = `${HEADLINE[r.outcome]}: ${o.summary}`;
  switch (r.outcome) {
    case "not_applied":
      lines.push(`${sentence(head)} Nothing was changed.`);
      break;
    case "partial":
      lines.push(`${sentence(head)} Some items remain applied; the JSON below gives the outcome of each.`);
      break;
    case "unknown":
      lines.push(`${sentence(head)} It is not known whether the change was applied.`);
      break;
    case "accepted":
      lines.push(`${sentence(head)} The backend has not yet reported the result.`);
      break;
    default:
      lines.push(sentence(head));
  }
  if (r.replayed) lines.push("Replay: this call repeats an earlier call with the same idempotency key and applied nothing itself; the answer describes the earlier call's write.");
  if (r.conflict && (r.conflict.current_state || r.conflict.current_version !== undefined)) lines.push("Its current state and version are in the JSON below.");
  if (r.changed) lines.push(`Changed: ${r.changed.length ? r.changed.map(q).join(", ") : "nothing"}.`);
  if (r.object?.version !== undefined && r.outcome !== "not_applied") lines.push(`Version now: ${q(r.object.version)}.`);
  const read = readSentence(r);
  switch (r.repeat) {
    case "no":
      lines.push("Do not send the same call again.");
      if (read) lines.push(`To see the current state, ${read}.`);
      break;
    case "yes":
      lines.push("The same call can be sent again unchanged; it cannot apply the write more than once.");
      if (read) lines.push(`To see the current state, ${read}.`);
      break;
    case "same_key":
      lines.push(`Send the call again only with the same ${o.keyArgument ?? "idempotency key"}${o.key !== undefined ? ` ${q(o.key)}` : ""}${read ? `, or first ${read}` : ""}.`);
      break;
    case "same_version":
      lines.push(`Send the call again only with the same ${r.version_argument ?? "version"}${o.sentVersion !== undefined ? ` ${q(o.sentVersion)}` : ""}${read ? `; or first ${read}` : ""}.`);
      break;
    case "read_first":
      lines.push(r.conflict && r.conflict.current_state && !(r.conflict.omitted?.length)
        ? `Build the write again from them${read ? `, or ${read}` : ""}; do not resend your earlier values with the new version.`
        : `Before writing again, ${read ?? "read the object"} and build the write from what the read shows.`);
      break;
    default:
      if (read) lines.push(`To see the current state, ${read}.`);
  }
  for (const n of o.notes ?? []) lines.push(sentence(n));
  return lines.join("\n");
}

/** The result for a shape that failed its check: the kit fails closed with an internal error. */
function failClosed(r: WriteResult, why: string): CallToolResult {
  const rw = r.read_with && typeof r.read_with.tool === "string" && typeof r.read_with.arguments === "object" && r.read_with.arguments !== null && !Array.isArray(r.read_with.arguments) ? r.read_with : undefined;
  const object = r.object && isIdv(r.object.id) ? clean({ type: typeof r.object.type === "string" ? r.object.type : undefined, id: r.object.id }) : undefined;
  const shape: WriteResult = clean({
    shape: SHAPE, outcome: "unknown" as const, repeat: "read_first" as const, code: "internal_error",
    message: `The server built a malformed result (${why}); the write may or may not have been applied.`,
    object, read_with: rw,
  });
  const structured = { mws: shape };
  return {
    content: [
      { type: "text", text: renderText(shape, { summary: "the server could not report what this call did" }) },
      { type: "text", text: JSON.stringify(structured) },
    ],
    structuredContent: structured,
    isError: true,
  };
}

/**
 * Builds the tool result: the shape in structuredContent.mws beside the tool's own output, the
 * sentence and the JSON in two text blocks. Fails closed: a shape that breaks B-9's rules gives an
 * `internal_error` result instead of a malformed one (call assertShape directly to see the rule).
 */
export function toToolResult(r: WriteResult, o: TextOptions, own: Record<string, unknown> = {}): CallToolResult {
  const shape = cleanShape(r);
  try {
    assertShape(shape);
    // B-9: same_key and same_version name a guard only where the call carried it. A replay answers a
    // call with the same arguments, so it carried the same key or version as the first.
    if (!shape.replayed && shape.repeat === "same_key" && o.key === undefined) {
      throw new TypeError(`write-result/0.1: repeat "same_key" only where the call carried an idempotency key: give key (and keyArgument)`);
    }
    if (!shape.replayed && shape.repeat === "same_version" && o.sentVersion === undefined) {
      throw new TypeError(`write-result/0.1: repeat "same_version" only where the call carried a version: give sentVersion`);
    }
    if (Object.prototype.hasOwnProperty.call(own, "mws")) throw new TypeError("the tool's own output must not have a member named mws");
  } catch (e) {
    return failClosed(shape, (e as Error).message);
  }
  const structured = { ...own, mws: shape };
  return {
    content: [
      { type: "text", text: renderText(shape, o) },
      { type: "text", text: JSON.stringify(structured) },
    ],
    structuredContent: structured,
    ...(isErrorFor(shape.outcome) ? { isError: true } : {}),
  };
}

function cleanShape(r: WriteResult): WriteResult {
  const out = clean({ ...r });
  if (out.object) {
    out.object = clean(out.object);
    if (out.object.parent) out.object.parent = clean(out.object.parent);
  }
  if (out.conflict) out.conflict = clean(out.conflict);
  if (out.items) out.items = out.items.map((i) => clean({ ...i, ...(i.conflict ? { conflict: clean(i.conflict) } : {}) }));
  if (out.argument_errors) out.argument_errors = out.argument_errors.map((e) => clean(e));
  return out;
}

// ---------------------------------------------------------------------------------------------
// Reader (B-9 reader rules)

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";

function readConflict(c: unknown): Conflict | undefined {
  if (!isObj(c)) return undefined;
  return clean<Conflict>({
    current_version: isIdv(c["current_version"]) ? c["current_version"] : undefined,
    checked_by: c["checked_by"] === "backend" || c["checked_by"] === "server" ? (c["checked_by"] as "backend" | "server") : undefined,
    current_state: isObj(c["current_state"]) ? c["current_state"] : undefined,
    omitted: Array.isArray(c["omitted"]) && c["omitted"].every(isPtr) ? c["omitted"] : undefined,
    held_by: isStr(c["held_by"]) ? c["held_by"] : undefined,
  });
}

/** A shape as read: like WriteResult, except that `outcome` is absent where it was missing or malformed. */
export type ReadShape = Omit<WriteResult, "outcome"> & { outcome?: Outcome };

/**
 * Reads the shape from a result, following B-9's reader rules: before 1.0 only version 0.1 is read
 * (another version is read as no shape); members it does not know, and members whose value does
 * not have the form 0.1 gives them, are dropped; the other members are still read where `outcome`
 * is missing or malformed.
 */
export function readResult(result: CallToolResult | { structuredContent?: unknown }): ReadShape | undefined {
  const sc = result.structuredContent;
  if (!isObj(sc) || !isObj(sc["mws"])) return undefined;
  const m = sc["mws"];
  if (m["shape"] !== SHAPE) return undefined;
  const out: Record<string, unknown> = { shape: SHAPE };
  if (OUTCOMES.includes(m["outcome"] as Outcome)) out["outcome"] = m["outcome"];
  if (REPEATS.includes(m["repeat"] as Repeat)) out["repeat"] = m["repeat"];
  if (isStr(m["operation"])) out["operation"] = m["operation"];
  if (isObj(m["object"])) {
    const ob = m["object"];
    const p = ob["parent"];
    const parent = isObj(p) ? clean({ type: isStr(p["type"]) ? p["type"] : undefined, id: isIdv(p["id"]) ? p["id"] : undefined, version: isIdv(p["version"]) ? p["version"] : undefined }) : undefined;
    out["object"] = clean({ type: isStr(ob["type"]) ? ob["type"] : undefined, id: isIdv(ob["id"]) ? ob["id"] : undefined, version: isIdv(ob["version"]) ? ob["version"] : undefined, scope: isStr(ob["scope"]) ? ob["scope"] : undefined, parent });
  }
  if (Array.isArray(m["changed"]) && m["changed"].every(isPtr)) out["changed"] = m["changed"];
  if (m["replayed"] === true) out["replayed"] = true;
  if (Array.isArray(m["items"])) {
    out["items"] = (m["items"] as unknown[])
      .filter((i): i is Record<string, unknown> => isObj(i) && ITEM_OUTCOMES.includes(i["outcome"] as ItemOutcome))
      .map((i) => clean({
        index: Number.isInteger(i["index"]) && (i["index"] as number) >= 0 ? (i["index"] as number) : undefined,
        step: isStr(i["step"]) ? i["step"] : undefined,
        id: isIdv(i["id"]) ? i["id"] : undefined,
        version: isIdv(i["version"]) ? i["version"] : undefined,
        outcome: i["outcome"] as ItemOutcome,
        code: isStr(i["code"]) && CODE.test(i["code"]) ? i["code"] : undefined,
        message: isStr(i["message"]) ? i["message"] : undefined,
        conflict: readConflict(i["conflict"]),
      }))
      .filter((i) => i.index !== undefined || i.step !== undefined || i.id !== undefined);
  }
  if (Number.isInteger(m["applied_count"]) && (m["applied_count"] as number) >= 0) out["applied_count"] = m["applied_count"];
  if (isStr(m["code"]) && CODE.test(m["code"])) out["code"] = m["code"];
  if (isStr(m["message"])) out["message"] = m["message"];
  if (isPtr(m["argument"])) out["argument"] = m["argument"];
  if (Array.isArray(m["argument_errors"])) {
    out["argument_errors"] = (m["argument_errors"] as unknown[])
      .filter((e): e is Record<string, unknown> => isObj(e) && isPtr(e["argument"]))
      .map((e) => clean({ argument: e["argument"] as string, code: isStr(e["code"]) && CODE.test(e["code"]) ? e["code"] : undefined, message: isStr(e["message"]) ? e["message"] : undefined }));
  }
  const c = readConflict(m["conflict"]);
  if (c) out["conflict"] = c;
  if (isObj(m["read_with"]) && isStr(m["read_with"]["tool"]) && isObj(m["read_with"]["arguments"])) out["read_with"] = { tool: m["read_with"]["tool"], arguments: m["read_with"]["arguments"] };
  if (isStr(m["version_argument"])) out["version_argument"] = m["version_argument"];
  return out as unknown as ReadShape;
}

// ---------------------------------------------------------------------------------------------
// Builders

interface Common extends TextOptions {
  /** The kind of write: "create", "update", "delete", or the name of a command. */
  operation?: string;
  /** The object written, with ids and versions in the JSON type the tool's arguments take. */
  object?: ObjectRef;
  /** A read that shows the object's current state. */
  readWith?: ReadWith;
  /** The tool's own output, put beside `mws` in structuredContent. */
  own?: Record<string, unknown>;
  versionArgument?: string;
}

export interface AppliedOptions extends Common {
  /**
   * The fields the write changed, as JSON Pointers or top-level field names; [] says nothing
   * changed. For a create, the fields the call set (no server-managed fields, defaults or scope
   * argument), or [""]. Leave out for a delete.
   */
  changed?: string[];
  /**
   * "same_key" where the call carried an idempotency key, "same_version" where it carried a
   * version, otherwise "no" (the default). Never "yes" after applied.
   */
  repeat?: "no" | "same_key" | "same_version";
  /** True for the answer to a repeat with the same idempotency key. */
  replayed?: boolean;
  /** For a write of several items: each item. */
  items?: Item[];
  /** For a write by selector: how many objects it was applied to. */
  appliedCount?: number;
}

/** A receipt: the state the caller asked for is in effect (MWS-RES-1, RES-3, RES-4). */
export function applied(o: AppliedOptions): CallToolResult {
  return toToolResult({
    shape: SHAPE,
    outcome: "applied",
    repeat: o.repeat ?? "no",
    operation: o.operation,
    object: o.object,
    changed: o.changed?.map(pointer),
    replayed: o.replayed ? true : undefined,
    items: o.items,
    applied_count: o.appliedCount,
    read_with: o.readWith,
    version_argument: o.versionArgument,
  }, o, o.own);
}

export interface NotAppliedOptions extends Common {
  /** A stable code: a reserved code that goes with not_applied, or the server's own. */
  code?: string;
  /** The reason in words. Default: the summary. */
  message?: string;
  /** The argument the reason concerns, as a JSON Pointer into the arguments, or a top-level name. */
  argument?: string;
  /** Every refused argument (MWS-IN-4). */
  argumentErrors?: ArgumentError[];
  /** Default "no" (a repeat would meet the same refusal). "yes" where no request that changes state was sent or the refusal may not recur. */
  repeat?: "no" | "yes" | "read_first";
  /** For a write of several items that applied none: each item. */
  items?: Item[];
}

/** A refusal: no change made by the call is in effect (`isError: true`; MWS-RES-2, CONC-4, IN-4). */
export function notApplied(o: NotAppliedOptions): CallToolResult {
  const { version: _v, ...object } = o.object ?? {};
  return toToolResult({
    shape: SHAPE,
    outcome: "not_applied",
    repeat: o.repeat ?? "no",
    operation: o.operation,
    object: o.object ? object : undefined,
    code: o.code,
    message: o.message ?? sentence(o.summary),
    argument: o.argument === undefined ? undefined : pointer(o.argument),
    argument_errors: o.argumentErrors?.map((e) => ({ ...e, argument: pointer(e.argument) })),
    items: o.items,
    read_with: o.readWith,
    version_argument: o.versionArgument,
  }, o, o.own);
}

export interface ItemsOptions extends Common {
  /**
   * The items or steps. An item of a list the call gave has `index`, and `id` once the object
   * exists; a step has `step`; an object a selector matched has `id`. With `partial` or `unknown`,
   * list every item; for a selector write, list at least every matched object not applied, and
   * give `appliedCount`.
   */
  items: Item[];
  appliedCount?: number;
  /** For partial or unknown: default "read_first"; "same_key" where the call carried a key. For applied: "no" or "same_key". */
  repeat?: Repeat;
  /** The top-level code. Default for a refusal: the code of the first item that was not applied. */
  code?: string;
  message?: string;
}

/**
 * A write of several items or steps, with the outcome derived from the items as B-9 defines it:
 * `unknown` where any item is unknown; `applied` where no item failed (also for a selector that
 * matched nothing); `not_applied` where items failed and none was applied (an all-or-nothing
 * refusal: the bad item `not_applied` with its code, the rest `not_attempted`, and the top-level
 * code that of the bad item); otherwise `partial` (MWS-ATOM-1, RES-2). A refusal over several
 * objects puts each conflict in its item and none at the top level.
 */
export function itemsResult(o: ItemsOptions): CallToolResult {
  const outs = o.items.map((i) => i.outcome);
  const anyApplied = outs.includes("applied") || (o.appliedCount ?? 0) > 0;
  const anyFailed = outs.some((x) => x === "not_applied" || x === "not_attempted");
  const outcome: Outcome = outs.includes("unknown") ? "unknown" : !anyFailed ? "applied" : anyApplied ? "partial" : "not_applied";
  const firstCode = o.items.find((i) => i.outcome === "not_applied" && i.code)?.code;
  if (outcome === "applied") return applied({ ...o, repeat: (o.repeat as AppliedOptions["repeat"]) ?? "no" });
  if (outcome === "not_applied") {
    const code = o.code ?? firstCode;
    return notApplied({ ...o, code, repeat: code === "conflict" ? "read_first" : (o.repeat as NotAppliedOptions["repeat"]) ?? "no" });
  }
  return toToolResult({
    shape: SHAPE,
    outcome,
    repeat: o.repeat ?? "read_first",
    operation: o.operation,
    object: o.object,
    items: o.items,
    applied_count: o.appliedCount,
    code: o.code,
    message: o.message,
    read_with: o.readWith,
  }, o, o.own);
}

export interface AcceptedOptions extends Omit<Common, "object"> {
  /** The object, without a version (the change is not yet made). */
  object?: Omit<ObjectRef, "version">;
  /** "same_key" where the call carried an idempotency key, else "no" (the default). */
  repeat?: "no" | "same_key";
}

/**
 * For operations the backend completes asynchronously only (NF-19): accepted for later processing,
 * result not yet reported. No `changed` and no `object.version`. For any other operation, a tester
 * reads `accepted` as a report that the write was made.
 */
export function accepted(o: AcceptedOptions): CallToolResult {
  return toToolResult({
    shape: SHAPE,
    outcome: "accepted",
    repeat: o.repeat ?? "no",
    operation: o.operation,
    object: o.object,
    read_with: o.readWith,
  }, o, o.own);
}

export interface ConflictOptions {
  /** The object whose write was refused. */
  id: Idv;
  /** Its kind, for `object.type` and the sentence ("note"). */
  type?: string;
  operation?: string;
  /** "conflict" (a version) or "locked" (a lock or another control). Default "conflict". */
  code?: "conflict" | "locked";
  /** The version the call carried, for the sentence ("changed since version 7"). */
  sentVersion?: Idv;
  /** The object's version when the write was refused, in the JSON type the version argument takes; leave out where there is none. */
  currentVersion?: Idv;
  /** "backend" where the backend's own check refused (B-2), "server" where the server compared (B-3). Default "server". */
  checkedBy?: "backend" | "server";
  /** The object as the read tool returns it, with only fields the caller may read and no secret. */
  currentState?: Record<string, unknown>;
  /** JSON Pointers (or top-level names) of the fields left out of currentState. */
  omitted?: string[];
  /** For a lock: who or what holds it, where the caller may be told. */
  heldBy?: string;
  /** The argument that takes the version. Default "expected_version". */
  versionArgument?: string;
  /** The read that shows the current state. */
  readWith: ReadWith;
  notes?: string[];
  own?: Record<string, unknown>;
}

/**
 * A write refused because the object changed since the state the call carried, or because of a
 * lock (MWS-CONC-1, CONC-2, CONC-4, CONC-6): `isError: true`, nothing applied, always
 * `repeat: "read_first"` with `read_with`, and the current version on its own beside the current
 * state as JSON.
 */
export function conflict(o: ConflictOptions): CallToolResult {
  const code = o.code ?? "conflict";
  const noun = o.type ?? "object";
  const summary = code === "locked"
    ? `${noun} ${q(o.id)} is locked${o.heldBy ? ` by ${q(o.heldBy)}` : ""}, so the write was refused`
    : `${noun} ${q(o.id)} changed since ${o.sentVersion !== undefined && o.sentVersion !== null ? `version ${q(o.sentVersion)}` : "the version you read"}`;
  return toToolResult({
    shape: SHAPE,
    outcome: "not_applied",
    repeat: "read_first",
    operation: o.operation,
    object: clean({ type: o.type, id: o.id }),
    code,
    message: sentence(summary),
    conflict: {
      current_version: present(o.currentVersion),
      checked_by: o.checkedBy ?? "server",
      current_state: o.currentState,
      omitted: o.omitted?.map(pointer),
      held_by: o.heldBy,
    },
    read_with: o.readWith,
    version_argument: code === "conflict" ? o.versionArgument ?? "expected_version" : o.versionArgument,
  }, { summary, notes: o.notes }, o.own);
}
