// The write-result shape, version 0.1 (MWS 0.9 draft Annex B-9), and the builders that produce it.
//
// The shape is the member `mws` of `structuredContent`; the tool's own output, if any, sits beside
// it. Every result also says in text what the shape says: the first text block is a plain sentence
// in the spec's words ("Applied", "Not applied", "Partly applied", "Outcome unknown", "Accepted")
// that names the read to make, and a second text block carries the serialized JSON of
// `structuredContent` (MWS-RES-1, RES-2, RES-4, ATOM-1, CONC-4, CONC-6).
//
// The shape is a draft (B-9 is not yet in the published spec) and may change before MWS 1.0.

import type { CallToolResult } from "./types.js";

/** The shape's name. */
export const SHAPE_NAME = "write-result" as const;
/** The version this kit writes. */
export const SHAPE_VERSION = "0.1" as const;
/** The value of `mws.shape`. */
export const SHAPE = `${SHAPE_NAME}/${SHAPE_VERSION}` as const;

/** What the write did, as a whole. */
export type Outcome = "applied" | "not_applied" | "partial" | "unknown" | "accepted";
/** Whether, and how, the same call may be sent again. */
export type Repeat = "no" | "yes" | "same_key" | "same_version" | "read_first";
/** The outcome of one item or step. */
export type ItemOutcome = "applied" | "not_applied" | "not_attempted" | "unknown";
/** The six codes whose meaning MWS fixes. A server may use others (lowercase letters, digits, underscores). */
export type FixedCode = "conflict" | "locked" | "version_required" | "invalid_argument" | "no_answer" | "not_sent";

/** A value given for an identifier or a version. The shape carries these as strings; the kit converts. */
export type Scalar = string | number;

/** The object written. Every member is a string in the shape. */
export interface ObjectRef {
  type?: string;
  id?: string;
  version?: string;
  scope?: string;
}

/** One item or step of a write of several. */
export interface Item {
  index: number;
  step?: string;
  id?: string;
  version?: string;
  outcome: ItemOutcome;
  code?: string;
  message?: string;
}

/** The state a write was refused against. */
export interface Conflict {
  current_version?: string;
  version_source?: "backend" | "server";
  current_state?: Record<string, unknown>;
  omitted?: string[];
  held_by?: string;
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

/** A JSON Pointer (RFC 6901) for a top-level field name; a value that already starts with "/" is kept. */
export function pointer(field: string): string {
  if (field.startsWith("/")) return field;
  return `/${field.replace(/~/g, "~0").replace(/\//g, "~1")}`;
}

/** A JSON Pointer from path segments: pointerOf(["tags", 2]) is "/tags/2". "" for no segments. */
export function pointerOf(segments: Array<string | number>): string {
  return segments.map((s) => `/${String(s).replace(/~/g, "~0").replace(/\//g, "~1")}`).join("");
}

// null and "" are treated as absent: B-9 never gives a member as null or a placeholder.
const str = (v: Scalar | undefined | null): string | undefined => (v === undefined || v === null || v === "" ? undefined : String(v));

/** An ObjectRef from values that may be numbers. */
export function objectRef(o: { type?: string; id?: Scalar; version?: Scalar; scope?: Scalar }): ObjectRef {
  return clean({ type: o.type, id: str(o.id), version: str(o.version), scope: str(o.scope) });
}

function clean<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

const CODE = /^[a-z0-9_]+$/;
const OUTCOMES: readonly Outcome[] = ["applied", "not_applied", "partial", "unknown", "accepted"];
const REPEATS: readonly Repeat[] = ["no", "yes", "same_key", "same_version", "read_first"];
const ITEM_OUTCOMES: readonly ItemOutcome[] = ["applied", "not_applied", "not_attempted", "unknown"];

/**
 * Checks a shape this kit is about to write. Throws a TypeError naming the first problem: a value
 * out of its list, a combination B-9 rules out (`unknown` with `repeat: "yes"`, a version without
 * a state or `read_first`, an object version on a refusal), or a code with other characters.
 */
export function assertShape(r: WriteResult): void {
  const fail = (m: string): never => {
    throw new TypeError(`write-result/0.1: ${m}`);
  };
  if (r.shape !== SHAPE) fail(`shape must be ${q(SHAPE)}`);
  if (!OUTCOMES.includes(r.outcome)) fail(`outcome ${q(r.outcome)} is not one of ${OUTCOMES.map(q).join(", ")}`);
  if (r.repeat !== undefined && !REPEATS.includes(r.repeat)) fail(`repeat ${q(r.repeat)} is not one of ${REPEATS.map(q).join(", ")}`);
  if (r.repeat === "yes" && (r.outcome === "unknown" || r.outcome === "partial" || r.outcome === "accepted")) {
    fail(`repeat "yes" is not allowed with outcome ${q(r.outcome)} (MWS-RES-2: an open outcome is repeated only after a read or with the key or version the call carried)`);
  }
  if (r.repeat === "yes" && r.outcome === "applied" && r.operation === "delete") {
    fail(`repeat "yes" is not allowed after an applied delete: a repeat can delete an object recreated in between`);
  }
  if (r.repeat === "read_first" && !r.read_with && !r.object?.id) {
    fail(`repeat "read_first" names a read only with read_with or object.id: give readWith`);
  }
  if (r.code !== undefined && !CODE.test(r.code)) fail(`code ${q(r.code)} must be lowercase letters, digits and underscores`);
  for (const it of r.items ?? []) {
    if (!Number.isInteger(it.index) || it.index < 0) fail(`items[].index must be an integer from 0`);
    if (!ITEM_OUTCOMES.includes(it.outcome)) fail(`items[].outcome ${q(it.outcome)} is not one of ${ITEM_OUTCOMES.map(q).join(", ")}`);
    if (it.code !== undefined && !CODE.test(it.code)) fail(`items[].code ${q(it.code)} must be lowercase letters, digits and underscores`);
  }
  if (r.outcome === "applied" || r.outcome === "not_applied") {
    const outs = (r.items ?? []).map((i) => i.outcome);
    if (outs.includes("unknown")) fail(`an item with an open outcome makes the whole outcome unknown, not ${r.outcome}`);
    if (r.outcome === "not_applied" && outs.includes("applied")) fail("not_applied says no change is in effect; an applied item makes it partial");
  }
  if (r.conflict?.current_version !== undefined && (typeof r.conflict.current_version !== "string" || r.conflict.current_version === "")) {
    fail("conflict.current_version is a non-empty string, or is left out");
  }
  if (r.applied_count !== undefined && (!Number.isInteger(r.applied_count) || r.applied_count < 0)) fail("applied_count must be a non-negative integer");
  if (r.outcome === "not_applied" && r.object?.version !== undefined) fail("on a refusal, object.version is left out (the current version goes in conflict.current_version)");
  if (r.conflict && r.code !== "conflict" && r.code !== "locked") fail(`conflict is present only where code is "conflict" or "locked"`);
  if (r.conflict?.current_version !== undefined && r.conflict.current_state === undefined && r.repeat !== "read_first") {
    fail(`a current_version needs current_state or repeat "read_first" (MWS-CONC-6: a version without the state is not enough)`);
  }
  for (const p of [...(r.changed ?? []), ...(r.conflict?.omitted ?? []), ...(r.argument !== undefined ? [r.argument] : [])]) {
    if (p !== "" && !p.startsWith("/")) fail(`${q(p)} is not a JSON Pointer`);
  }
  if (r.read_with && (typeof r.read_with.tool !== "string" || typeof r.read_with.arguments !== "object" || r.read_with.arguments === null)) {
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
  sentVersion?: Scalar;
}

function readSentence(r: WriteResult): string | null {
  if (!r.read_with) return null;
  return `read it with ${q(r.read_with.tool)} and the arguments ${JSON.stringify(r.read_with.arguments)}`;
}

/**
 * Renders the first text block: the outcome in plain words, the facts a reader needs first, the
 * repeat instruction and the read to make. The full shape follows in the second text block.
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
  if (r.replayed) lines.push("Replay: this call repeats an earlier call with the same idempotency key and the same arguments; it is answered with that call's outcome, and nothing was applied again.");
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
      lines.push(`Send the call again only with the same ${r.version_argument ?? "version"}${o.sentVersion !== undefined ? ` ${q(o.sentVersion)}` : ""}: if the first call was applied, the repeat is refused${read ? `; or first ${read}` : ""}.`);
      break;
    case "read_first":
      lines.push(r.conflict?.current_state && !(r.conflict.omitted?.length)
        ? `Build the write again from the current state in the JSON below${read ? `, or ${read}` : ""}; do not resend your earlier values with the new version.`
        : `Before writing again, ${read ?? "read the object"} and build the write from what the read shows.`);
      break;
    default:
      if (read) lines.push(`To see the current state, ${read}.`);
  }
  for (const n of o.notes ?? []) lines.push(sentence(n));
  return lines.join("\n");
}

/** Builds the tool result: the shape in structuredContent.mws, the sentence and the JSON in two text blocks. */
export function toToolResult(r: WriteResult, o: TextOptions, own: Record<string, unknown> = {}): CallToolResult {
  const shape = cleanShape(r);
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
  if (out.object) out.object = clean(out.object);
  if (out.conflict) out.conflict = clean(out.conflict);
  if (out.items) out.items = out.items.map((i) => clean(i));
  return out;
}

// ---------------------------------------------------------------------------------------------
// Reader (B-9 reader rules)

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isPtr = (v: unknown): v is string => isStr(v) && (v === "" || v.startsWith("/"));

/**
 * Reads the shape from a result. Follows B-9's reader rules: a result of another MAJOR version is
 * read as if it carried no shape (undefined); members it does not know, and members whose value
 * does not have the form 0.1 gives them, are dropped. Returns undefined where there is no shape or
 * `outcome` is not well formed.
 */
export function readResult(result: CallToolResult | { structuredContent?: unknown }): WriteResult | undefined {
  const sc = result.structuredContent;
  if (!isObj(sc) || !isObj(sc["mws"])) return undefined;
  const m = sc["mws"];
  const shape = m["shape"];
  if (!isStr(shape)) return undefined;
  const mm = /^write-result\/(\d+)\.(\d+)$/.exec(shape);
  if (!mm || mm[1] !== "0") return undefined;
  if (!OUTCOMES.includes(m["outcome"] as Outcome)) return undefined;
  const out: Record<string, unknown> = { shape, outcome: m["outcome"] };
  if (REPEATS.includes(m["repeat"] as Repeat)) out["repeat"] = m["repeat"];
  if (isStr(m["operation"])) out["operation"] = m["operation"];
  if (isObj(m["object"])) {
    const ob = Object.fromEntries(["type", "id", "version", "scope"].filter((k) => isStr((m["object"] as Record<string, unknown>)[k])).map((k) => [k, (m["object"] as Record<string, unknown>)[k]]));
    out["object"] = ob;
  }
  if (Array.isArray(m["changed"]) && m["changed"].every(isPtr)) out["changed"] = m["changed"];
  if (m["replayed"] === true) out["replayed"] = true;
  if (Array.isArray(m["items"])) {
    out["items"] = (m["items"] as unknown[]).filter((i): i is Record<string, unknown> => isObj(i) && Number.isInteger(i["index"]) && ITEM_OUTCOMES.includes(i["outcome"] as ItemOutcome))
      .map((i) => clean({ index: i["index"], step: isStr(i["step"]) ? i["step"] : undefined, id: isStr(i["id"]) ? i["id"] : undefined, version: isStr(i["version"]) ? i["version"] : undefined, outcome: i["outcome"], code: isStr(i["code"]) && CODE.test(i["code"]) ? i["code"] : undefined, message: isStr(i["message"]) ? i["message"] : undefined }));
  }
  if (Number.isInteger(m["applied_count"]) && (m["applied_count"] as number) >= 0) out["applied_count"] = m["applied_count"];
  if (isStr(m["code"]) && CODE.test(m["code"])) out["code"] = m["code"];
  if (isStr(m["message"])) out["message"] = m["message"];
  if (isPtr(m["argument"])) out["argument"] = m["argument"];
  if (isObj(m["conflict"])) {
    const c = m["conflict"];
    out["conflict"] = clean({
      current_version: isStr(c["current_version"]) ? c["current_version"] : undefined,
      version_source: c["version_source"] === "backend" || c["version_source"] === "server" ? c["version_source"] : undefined,
      current_state: isObj(c["current_state"]) ? c["current_state"] : undefined,
      omitted: Array.isArray(c["omitted"]) && c["omitted"].every(isPtr) ? c["omitted"] : undefined,
      held_by: isStr(c["held_by"]) ? c["held_by"] : undefined,
    });
  }
  if (isObj(m["read_with"]) && isStr(m["read_with"]["tool"]) && isObj(m["read_with"]["arguments"])) out["read_with"] = { tool: m["read_with"]["tool"], arguments: m["read_with"]["arguments"] };
  if (isStr(m["version_argument"])) out["version_argument"] = m["version_argument"];
  return out as unknown as WriteResult;
}

// ---------------------------------------------------------------------------------------------
// Builders

interface Common extends TextOptions {
  /** The kind of write: "create", "update", "delete", or the name of a command. */
  operation?: string;
  /** The object written. Numbers are converted to strings. */
  object?: { type?: string; id?: Scalar; version?: Scalar; scope?: Scalar };
  /** A read that shows the object's current state. */
  readWith?: ReadWith;
  /** The tool's own output, put beside `mws` in structuredContent. */
  own?: Record<string, unknown>;
}

export interface AppliedOptions extends Common {
  /** The fields the write changed, as JSON Pointers or top-level field names; [] says nothing changed. Leave out for a delete. */
  changed?: string[];
  /** Default "no". "yes" only where a repeat cannot apply the write twice and cannot undo another writer's change. */
  repeat?: Repeat;
  /** True for the answer to a repeat with the same idempotency key. */
  replayed?: boolean;
  /** For a write of several items: each item (all applied). */
  items?: Item[];
  /** For a write by selector: how many objects it was applied to. */
  appliedCount?: number;
  versionArgument?: string;
}

/** A receipt: the state the caller asked for is in effect (MWS-RES-1, RES-3, RES-4). */
export function applied(o: AppliedOptions): CallToolResult {
  return toToolResult({
    shape: SHAPE,
    outcome: "applied",
    repeat: o.repeat ?? "no",
    operation: o.operation,
    object: o.object ? objectRef(o.object) : undefined,
    changed: o.changed?.map(pointer),
    replayed: o.replayed ? true : undefined,
    items: o.items,
    applied_count: o.appliedCount,
    read_with: o.readWith,
    version_argument: o.versionArgument,
  }, o, o.own);
}

export interface NotAppliedOptions extends Common {
  /** A stable code: one of the fixed codes, or the server's own. */
  code?: string;
  /** The reason in words. Default: the summary. */
  message?: string;
  /** The argument the reason concerns, as a JSON Pointer into the arguments, or a top-level name. */
  argument?: string;
  /** Default "no" (a repeat would meet the same refusal). "yes" where no request that changes state was sent or the refusal may not recur. */
  repeat?: Repeat;
  /** For a write of several items that applied none: each item. */
  items?: Item[];
  versionArgument?: string;
}

/** A refusal: no change made by the call is in effect (`isError: true`; MWS-RES-2, CONC-4, IN-4). */
export function notApplied(o: NotAppliedOptions): CallToolResult {
  const { version: _v, ...object } = o.object ?? {};
  return toToolResult({
    shape: SHAPE,
    outcome: "not_applied",
    repeat: o.repeat ?? "no",
    operation: o.operation,
    object: o.object ? objectRef(object) : undefined,
    code: o.code,
    message: o.message ?? sentence(o.summary),
    argument: o.argument === undefined ? undefined : pointer(o.argument),
    items: o.items,
    read_with: o.readWith,
    version_argument: o.versionArgument,
  }, o, o.own);
}

export interface ItemsOptions extends Common {
  /** Every item or step, with its outcome. */
  items: Item[];
  /** For a write by selector: how many objects it was applied to (items then list at least every one it was not). */
  appliedCount?: number;
  /** For an outcome that is partial or unknown: "same_key" where the call carried a key, else "read_first" (the default). */
  repeat?: Repeat;
  code?: string;
  message?: string;
}

/**
 * A write of several items or steps, with the outcome derived from the items as B-9 defines it:
 * `unknown` where any item is unknown; `applied` where no item failed (also for a selector that
 * matched nothing); `not_applied` where items failed and none was applied; otherwise `partial`
 * (MWS-ATOM-1, RES-2).
 */
export function itemsResult(o: ItemsOptions): CallToolResult {
  const outs = o.items.map((i) => i.outcome);
  const anyApplied = outs.includes("applied") || (o.appliedCount ?? 0) > 0;
  const anyFailed = outs.some((x) => x === "not_applied" || x === "not_attempted");
  const outcome: Outcome = outs.includes("unknown") ? "unknown"
    : !anyFailed ? "applied"
    : anyApplied ? "partial" : "not_applied";
  if (outcome === "applied") return applied({ ...o, repeat: o.repeat ?? "no" });
  if (outcome === "not_applied") return notApplied({ ...o, repeat: o.repeat ?? "no" });
  return toToolResult({
    shape: SHAPE,
    outcome,
    repeat: o.repeat ?? "read_first",
    operation: o.operation,
    object: o.object ? objectRef(o.object) : undefined,
    items: o.items,
    applied_count: o.appliedCount,
    code: o.code,
    message: o.message,
    read_with: o.readWith,
  }, o, o.own);
}

export interface AcceptedOptions extends Common {}

/** Accepted for later processing by a backend that completes the operation asynchronously (NF-19). */
export function accepted(o: AcceptedOptions): CallToolResult {
  return toToolResult({
    shape: SHAPE,
    outcome: "accepted",
    repeat: "no",
    operation: o.operation,
    object: o.object ? objectRef(o.object) : undefined,
    read_with: o.readWith,
  }, o, o.own);
}

export interface ConflictOptions {
  /** The object whose write was refused. */
  id: Scalar;
  /** Its kind, for `object.type` and the sentence ("note"). */
  type?: string;
  operation?: string;
  /** "conflict" (a version) or "locked" (a lock or another control). Default "conflict". */
  code?: "conflict" | "locked";
  /** The object's version when the write was refused; leave out where the backend has none. */
  currentVersion?: Scalar;
  /** "backend" where the version is the backend's own, "server" where the server derives it (B-3). Default "backend". */
  versionSource?: "backend" | "server";
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
 * lock (MWS-CONC-1, CONC-2, CONC-4, CONC-6): `isError: true`, nothing applied, `repeat:
 * "read_first"`, and the current version on its own beside the current state as JSON.
 */
export function conflict(o: ConflictOptions): CallToolResult {
  const code = o.code ?? "conflict";
  const noun = o.type ?? "object";
  const summary = code === "locked"
    ? `${noun} ${q(String(o.id))} is locked${o.heldBy ? ` by ${q(o.heldBy)}` : ""}, so the write was refused`
    : `${noun} ${q(String(o.id))} changed since the version you read${str(o.currentVersion) !== undefined ? `; it is now at version ${q(o.currentVersion)}` : ""}`;
  return toToolResult({
    shape: SHAPE,
    outcome: "not_applied",
    repeat: "read_first",
    operation: o.operation,
    object: objectRef({ type: o.type, id: o.id }),
    code,
    message: sentence(summary),
    conflict: {
      current_version: str(o.currentVersion),
      version_source: str(o.currentVersion) !== undefined ? o.versionSource ?? "backend" : undefined,
      current_state: o.currentState,
      omitted: o.omitted?.map(pointer),
      held_by: o.heldBy,
    },
    read_with: o.readWith,
    version_argument: code === "conflict" ? o.versionArgument ?? "expected_version" : o.versionArgument,
  }, { summary, notes: o.notes }, o.own);
}
