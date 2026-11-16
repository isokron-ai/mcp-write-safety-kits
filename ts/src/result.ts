// The MWS result shape v0 (provisional) and the builders that produce it.
//
// Every write result carries the shape in `structuredContent` and mirrors it in one text block, in
// plain sentences with every value quoted or given as JSON, so that a caller that reads only the
// text learns the same facts as one that reads the structure (MWS-RES-1, RES-2, RES-4, ATOM-1,
// CONC-4, CONC-6). The shape is shared with the Python kit; it may change before MWS 1.0.

import type { CallToolResult } from "./types.js";

/** The value of the `mws` field: the name and version of the shape. */
export const RESULT_SHAPE = "result/v0" as const;

/** What happened to the write the caller asked for. */
export type Outcome = "applied" | "not_applied" | "unknown";

/** An object identifier. The shape does not fix a JSON type; give it as the read tool gives it. */
export type Id = string | number;

/**
 * A version, in the JSON type the write tool's version argument accepts (a number, or a string such
 * as an entity tag), so that a caller can send it back as it is.
 */
export type Version = string | number;

/** An object, by identifier, and its version where the resource has one. */
export interface ObjectRef {
  id: Id;
  version?: Version;
}

/** An item that was not applied, and why. */
export interface FailedItem {
  id: Id;
  reason: string;
}

/** The current state of an object whose write was refused because it changed. */
export interface ConflictInfo {
  current_version: Version;
  current_state: Record<string, unknown>;
}

/** MWS result shape v0 (provisional). Fields that are not relevant to a result are omitted. */
export interface MwsResult {
  mws: typeof RESULT_SHAPE;
  outcome: Outcome;
  /**
   * True when sending exactly the same call again cannot apply the write a second time and cannot
   * undo another writer's change: for example a refusal that applied nothing, a write guarded by the
   * version it carried, or a write carrying an idempotency key the server honours.
   */
  safe_to_repeat: boolean;
  object?: ObjectRef;
  changed?: string[];
  applied?: ObjectRef[];
  failed?: FailedItem[];
  conflict?: ConflictInfo;
  settle_with?: string;
}

/** Options shared by every builder. */
export interface TextOptions {
  /**
   * One plain sentence about the write, without a final period, e.g. `updated note "n-3"`. It
   * follows the fixed opening word ("Applied:", "Not applied:", "Outcome unknown:"). Quote every
   * value in it (use `q()`).
   */
  summary: string;
  /** Further sentences, appended after the facts of the shape. */
  notes?: string[];
}

/** Quotes a value for a sentence: strings and other values as JSON, so each can be read only one way. */
export function q(value: unknown): string {
  return JSON.stringify(value) ?? "null";
}

function ref(r: ObjectRef): string {
  return r.version === undefined ? q(r.id) : `${q(r.id)} (version ${q(r.version)})`;
}

function sentence(s: string): string {
  const t = s.trim();
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

/**
 * Renders the text block that mirrors a result. The first word is fixed by the outcome, so that a
 * tester's declared pattern can decide what the result says (spec 7.3, rule 11):
 *
 *   "Applied:"                 outcome applied
 *   "Not applied:"             outcome not_applied, nothing remains applied
 *   "Not applied in full:"     outcome not_applied, some items remain applied (listed)
 *   "Outcome unknown:"         outcome unknown
 */
export function renderText(r: MwsResult, o: TextOptions): string {
  const lines: string[] = [];
  const partial = r.outcome === "not_applied" && (r.applied?.length ?? 0) > 0;
  switch (r.outcome) {
    case "applied":
      lines.push(sentence(`Applied: ${o.summary}`));
      break;
    case "not_applied":
      lines.push(partial
        ? sentence(`Not applied in full: ${o.summary}`) + " Some items remain applied; each is listed below."
        : sentence(`Not applied: ${o.summary}`) + " Nothing was changed.");
      break;
    case "unknown":
      lines.push(sentence(`Outcome unknown: ${o.summary}`) + " It is not known whether the change was applied.");
      break;
  }
  if (r.object) lines.push(`Object: id ${q(r.object.id)}${r.object.version === undefined ? "" : `, version ${q(r.object.version)}`}.`);
  if (r.changed) lines.push(`Changed fields: ${r.changed.length ? r.changed.map(q).join(", ") : "none"}.`);
  if (r.applied) lines.push(`Applied items (${r.applied.length}): ${r.applied.length ? r.applied.map(ref).join(", ") : "none"}.`);
  if (r.failed) lines.push(`Items not applied (${r.failed.length}): ${r.failed.length ? r.failed.map((f) => `${q(f.id)} (${q(f.reason)})`).join(", ") : "none"}.`);
  if (r.conflict) {
    lines.push(`Current version: ${q(r.conflict.current_version)}.`);
    lines.push(`Current state (JSON): ${JSON.stringify(r.conflict.current_state)}`);
  }
  if (r.settle_with) {
    lines.push(r.outcome === "unknown"
      ? `Settle it with ${q(r.settle_with)}: read the object before sending this write again.`
      : `Read it with ${q(r.settle_with)}.`);
  }
  lines.push(`Safe to repeat: ${r.safe_to_repeat ? "yes" : "no"}.`);
  for (const n of o.notes ?? []) lines.push(sentence(n));
  return lines.join("\n");
}

/** Checks the invariants of the shape. Throws a TypeError naming the first one broken. */
export function assertShape(r: MwsResult): void {
  const fail = (m: string): never => {
    throw new TypeError(`MWS result shape v0: ${m}`);
  };
  if (r.mws !== RESULT_SHAPE) fail(`mws must be ${q(RESULT_SHAPE)}`);
  if (!["applied", "not_applied", "unknown"].includes(r.outcome)) fail(`outcome ${q(r.outcome)} is not one of "applied", "not_applied", "unknown"`);
  if (typeof r.safe_to_repeat !== "boolean") fail("safe_to_repeat must be a boolean");
  if (r.outcome === "unknown" && !r.settle_with) fail("an unknown outcome must name the read tool that settles it (settle_with)");
  if (r.conflict && r.outcome !== "not_applied") fail("a conflict is a write that was not applied");
  if (r.outcome === "applied" && r.failed?.length) fail("an applied result has no failed items; use outcome not_applied with applied and failed");
  if (r.conflict && (r.conflict.current_version === undefined || r.conflict.current_state === undefined)) fail("a conflict carries current_version and current_state");
}

/** Builds the tool result for a shape: the shape in structuredContent, the mirror in one text block. */
export function toToolResult(r: MwsResult, o: TextOptions): CallToolResult {
  assertShape(r);
  const structured = clean(r);
  return {
    content: [{ type: "text", text: renderText(r, o) }],
    structuredContent: structured as unknown as Record<string, unknown>,
    ...(r.outcome === "applied" ? {} : { isError: true }),
  };
}

/** Drops undefined fields, so that a field not relevant to a result is omitted, not null. */
function clean(r: MwsResult): MwsResult {
  return Object.fromEntries(Object.entries(r).filter(([, v]) => v !== undefined)) as unknown as MwsResult;
}

// ---------------------------------------------------------------------------------------------
// Builders

export interface AppliedOptions extends TextOptions {
  /** The object written, with its new version where the resource has one (MWS-RES-3, RES-4). */
  object?: ObjectRef;
  /** The fields the call changed; an empty list says the call changed nothing (MWS-RES-1 guidance). */
  changed?: string[];
  /** For a write of several objects: each object applied. */
  applied?: ObjectRef[];
  /** See MwsResult.safe_to_repeat. Default false, the cautious value. */
  safeToRepeat?: boolean;
  /** A read tool that shows the result. */
  settleWith?: string;
}

/** A success receipt: the write is in effect (MWS-RES-1, RES-4). */
export function applied(o: AppliedOptions): CallToolResult {
  return toToolResult({
    mws: RESULT_SHAPE,
    outcome: "applied",
    safe_to_repeat: o.safeToRepeat ?? false,
    object: o.object,
    changed: o.changed,
    applied: o.applied,
    settle_with: o.settleWith,
  }, o);
}

export interface NotAppliedOptions extends TextOptions {
  object?: ObjectRef;
  /** The items that were not applied, with the reason for each (MWS-ATOM-1). */
  failed?: FailedItem[];
  /** Default true: nothing was applied, so the same call cannot apply anything twice. */
  safeToRepeat?: boolean;
  settleWith?: string;
}

/**
 * A refusal: nothing was applied (`isError: true`). Use it for a backend refusal, a rule of the
 * tool, a missing object, and an all-or-nothing batch that applied nothing (MWS-RES-2, ATOM-1).
 */
export function notApplied(o: NotAppliedOptions): CallToolResult {
  return toToolResult({
    mws: RESULT_SHAPE,
    outcome: "not_applied",
    safe_to_repeat: o.safeToRepeat ?? true,
    object: o.object,
    failed: o.failed,
    settle_with: o.settleWith,
  }, o);
}

export interface PartialOptions extends TextOptions {
  /** Every item that remains applied. */
  applied: ObjectRef[];
  /** Every item that was not applied, with the reason (including items not attempted). */
  failed: FailedItem[];
  /** Default false: repeating the call would apply the items that were applied again. */
  safeToRepeat?: boolean;
  settleWith?: string;
}

/**
 * A multi-item or multi-step write that was not applied in full: never a success (`isError:
 * true`), and it names each item applied and each item not applied (MWS-ATOM-1, RES-2). The shape
 * v0 has no "partial" outcome; such a write is `not_applied` with a non-empty `applied` list.
 */
export function partial(o: PartialOptions): CallToolResult {
  if (o.applied.length === 0) return notApplied({ ...o, safeToRepeat: o.safeToRepeat ?? true });
  return toToolResult({
    mws: RESULT_SHAPE,
    outcome: "not_applied",
    safe_to_repeat: o.safeToRepeat ?? false,
    applied: o.applied,
    failed: o.failed,
    settle_with: o.settleWith,
  }, o);
}

export interface ConflictOptions {
  /** The object whose write was refused. */
  id: Id;
  /** What kind of object it is, for the sentence ("note"). Default "object". */
  noun?: string;
  /** The object's current version, under the name the write tool accepts (`versionArg`). */
  currentVersion: Version;
  /** The object's current state, as the read tool returns it (keep it compact). */
  currentState: Record<string, unknown>;
  /** The argument that takes the version. Default "expected_version". */
  versionArg?: string;
  /** The read tool that returns the object. */
  readTool: string;
  /** Further sentences. */
  notes?: string[];
}

/**
 * A write refused because the object changed since the version the caller read (MWS-CONC-2,
 * CONC-4, CONC-6). It is a tool execution error, says that nothing was applied, carries the current
 * version on its own under the name the write tool accepts and the current state as JSON, and tells
 * the caller to apply its change to that state or read again; never to resend its old values with
 * the new version.
 */
export function conflict(o: ConflictOptions): CallToolResult {
  const noun = o.noun ?? "object";
  const arg = o.versionArg ?? "expected_version";
  return toToolResult({
    mws: RESULT_SHAPE,
    outcome: "not_applied",
    safe_to_repeat: true,
    object: { id: o.id },
    conflict: { current_version: o.currentVersion, current_state: o.currentState },
    settle_with: o.readTool,
  }, {
    summary: `${noun} ${q(o.id)} changed since the version you read, so the write was refused (conflict)`,
    notes: [
      `To write again, send ${arg} ${q(o.currentVersion)} with your change applied to the current state above, or read it again with ${q(o.readTool)} first`,
      `Do not resend your earlier values with the new ${arg}: that would overwrite the other writer's change`,
      ...(o.notes ?? []),
    ],
  });
}

/** Reads the shape back from a tool result, or returns undefined where there is none. */
export function readResult(result: CallToolResult): MwsResult | undefined {
  const s = result.structuredContent as Partial<MwsResult> | undefined;
  return s && s.mws === RESULT_SHAPE ? (s as MwsResult) : undefined;
}

/** The JSON Schema of the shape, for a tool's `outputSchema` or for tests. */
export const RESULT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "MWS result shape v0 (provisional)",
  type: "object",
  required: ["mws", "outcome", "safe_to_repeat"],
  properties: {
    mws: { const: RESULT_SHAPE },
    outcome: { enum: ["applied", "not_applied", "unknown"] },
    safe_to_repeat: { type: "boolean" },
    object: { $ref: "#/$defs/ref" },
    changed: { type: "array", items: { type: "string" } },
    applied: { type: "array", items: { $ref: "#/$defs/ref" } },
    failed: {
      type: "array",
      items: { type: "object", required: ["id", "reason"], properties: { id: { $ref: "#/$defs/id" }, reason: { type: "string" } } },
    },
    conflict: {
      type: "object",
      required: ["current_version", "current_state"],
      properties: { current_version: { $ref: "#/$defs/version" }, current_state: { type: "object" } },
    },
    settle_with: { type: "string" },
  },
  $defs: {
    id: { type: ["string", "integer"] },
    version: { type: ["string", "integer"] },
    ref: { type: "object", required: ["id"], properties: { id: { $ref: "#/$defs/id" }, version: { $ref: "#/$defs/version" } } },
  },
} as const;
