// Unknown outcomes (MWS-RES-2).
//
// When a write was sent to the backend and its answer was lost (a timeout, a closed or reset
// connection), the server does not know whether the write was applied. Saying that it failed
// invites a retry and a duplicate; saying that it succeeded may be false. The truthful answer is a
// tool execution error that says the outcome is unknown, names the read that settles it, and says
// whether the same call is safe to send again. The spec allows an invitation to repeat only after
// the named read, or with the idempotency key or the version that the call carried.

import { RESULT_SHAPE, q, toToolResult, notApplied, type ObjectRef } from "./result.js";
import type { CallToolResult } from "./types.js";

/** What guards a repeat of the same call: the idempotency key or the version it carried. */
export interface RepeatGuard {
  /** The argument and value of the idempotency key the call carried, where the server honours it. */
  idempotencyKey?: { arg: string; value: string };
  /** The argument and value of the version the call carried, where the write is refused on a mismatch. */
  version?: { arg: string; value: string | number };
}

export interface UnknownOutcomeOptions {
  /** One sentence about what was sent, without a final period, e.g. `the update to note "n-3" was sent and no answer arrived`. */
  summary: string;
  /** The read tool that shows whether the write took effect (required). */
  settleWith: string;
  /** The object the write was for, where known. */
  object?: ObjectRef;
  /**
   * What makes a blind repeat safe. Without one, `safe_to_repeat` is false and the text tells the
   * caller to read first. With one, the text says the repeat is safe with that key or version.
   */
  guard?: RepeatGuard;
  /** The cause, in a few words ("timeout after 30 s", "connection reset"). Never include a request with credentials. */
  cause?: string;
  notes?: string[];
}

/** A tool execution error that says the outcome is unknown (MWS-RES-2). */
export function unknownOutcome(o: UnknownOutcomeOptions): CallToolResult {
  const g = o.guard;
  const safe = !!(g?.idempotencyKey || g?.version);
  const notes: string[] = [];
  if (o.cause) notes.push(`Cause: ${o.cause}`);
  if (g?.idempotencyKey) notes.push(`Sending the same call again with the same ${g.idempotencyKey.arg} ${q(g.idempotencyKey.value)} will not apply it twice`);
  else if (g?.version) notes.push(`Sending the same call again with the same ${g.version.arg} ${q(g.version.value)} will not apply it twice: if the first call was applied, the repeat is refused as a conflict`);
  else notes.push(`Do not send the same call again before reading with ${q(o.settleWith)}: it may apply the change a second time or undo another writer's change`);
  return toToolResult({
    mws: RESULT_SHAPE,
    outcome: "unknown",
    safe_to_repeat: safe,
    object: o.object,
    settle_with: o.settleWith,
  }, { summary: o.summary, notes: [...notes, ...(o.notes ?? [])] });
}

/** Thrown by a write callback when the backend refused the write: nothing was applied. */
export class NotAppliedError extends Error {
  override readonly name = "NotAppliedError";
  constructor(message: string, readonly detail: { object?: ObjectRef } = {}) {
    super(message);
  }
}

/** Thrown by a write callback when the request may have reached the backend and no answer arrived. */
export class OutcomeUnknownError extends Error {
  override readonly name = "OutcomeUnknownError";
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

/**
 * How a thrown error bears on a write that was being sent:
 *
 *   "not_applied"  the backend refused it, or the request was never sent (connection refused,
 *                  name not resolved): the outcome is settled, nothing was applied
 *   "unknown"      the request may have been sent and no answer arrived, or the error is not
 *                  recognised (the cautious reading: never report "failed" when unsure)
 */
export type ErrorClass = "not_applied" | "unknown";

/** Error codes meaning the request was not sent: the connection was never made. */
const NOT_SENT_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "ERR_INVALID_URL", "UND_ERR_CONNECT_TIMEOUT"]);

function codeOf(e: unknown): string | undefined {
  let cur: unknown = e;
  for (let i = 0; i < 4 && cur && typeof cur === "object"; i++) {
    const c = (cur as { code?: unknown }).code;
    if (typeof c === "string") return c;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

/** Classifies an error thrown while sending a write. See ErrorClass. */
export function classifyError(e: unknown): ErrorClass {
  if (e instanceof NotAppliedError) return "not_applied";
  if (e instanceof OutcomeUnknownError) return "unknown";
  const code = codeOf(e);
  if (code && NOT_SENT_CODES.has(code)) return "not_applied";
  return "unknown";
}

export interface GuardWriteOptions {
  /** The read tool that settles an unknown outcome. */
  settleWith: string;
  /** The object, for the error. */
  object?: ObjectRef;
  /** One sentence for an unknown outcome, e.g. `the update to note "n-3" was sent and no answer arrived`. */
  what: string;
  /** What guards a repeat of this call, where anything does. */
  guard?: RepeatGuard;
}

/**
 * Runs a write and turns a thrown error into a truthful result: a refusal or an unsent request
 * becomes "not applied", anything else becomes "outcome unknown" naming the read that settles it.
 * The error's message is not copied into the result unless it is a NotAppliedError, whose message
 * the caller wrote for this purpose (a raw client error can carry a URL with a token, MWS-SEC-1).
 */
export async function guardWrite(write: () => Promise<CallToolResult>, o: GuardWriteOptions): Promise<CallToolResult> {
  try {
    return await write();
  } catch (e) {
    if (classifyError(e) === "not_applied") {
      const reason = e instanceof NotAppliedError ? e.message : "the backend could not be reached, so the request was not sent";
      return notApplied({ summary: reason, object: e instanceof NotAppliedError ? e.detail.object ?? o.object : o.object });
    }
    const code = codeOf(e);
    return unknownOutcome({
      summary: o.what,
      settleWith: o.settleWith,
      object: o.object,
      guard: o.guard,
      cause: e instanceof OutcomeUnknownError ? e.message : code ? `error code ${code}` : undefined,
    });
  }
}
