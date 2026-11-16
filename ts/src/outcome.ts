// Unknown outcomes (MWS-RES-2).
//
// When a write was sent to the backend and its answer was lost (a timeout, a closed or reset
// connection), the server does not know whether the write was applied. Saying that it failed
// invites a retry and a duplicate; saying that it succeeded may be false. The truthful answer is a
// tool execution error with `outcome: "unknown"` and `code: "no_answer"`, a `read_with` that
// settles it, and a `repeat` that MWS-RES-2 allows: `read_first`, or `same_key` / `same_version`
// where the call carried an idempotency key or a version that guards the repeat. Never `yes`.

import { SHAPE, notApplied, objectRef, toToolResult, type ReadWith, type Repeat, type Scalar } from "./result.js";
import type { CallToolResult } from "./types.js";

/** What guards a repeat of the same call: the idempotency key or the version it carried. */
export interface RepeatGuard {
  /** The argument and value of the idempotency key the call carried, where the server honours it. */
  idempotencyKey?: { arg: string; value: string };
  /** The argument and value of the version the call carried, where a repeat that finds the write applied is refused. */
  version?: { arg: string; value: Scalar };
}

export interface UnknownOutcomeOptions {
  /** One sentence about what was sent, without a final period, e.g. `the update to note "n-3" was sent and no answer arrived`. */
  summary: string;
  /** The read that shows whether the write took effect (required). */
  readWith: ReadWith;
  /** The object the write was for, where known. */
  object?: { type?: string; id?: Scalar; scope?: Scalar };
  operation?: string;
  /** What makes a repeat safe. Without one, `repeat` is "read_first". */
  guard?: RepeatGuard;
  /** The code. Default "no_answer". */
  code?: string;
  /** The reason in words ("timeout after 30 s", "connection reset"). Never a request with credentials. */
  message?: string;
  notes?: string[];
  own?: Record<string, unknown>;
}

/** A tool execution error that says the outcome is unknown (MWS-RES-2). */
export function unknownOutcome(o: UnknownOutcomeOptions): CallToolResult {
  const g = o.guard;
  const repeat: Repeat = g?.idempotencyKey ? "same_key" : g?.version ? "same_version" : "read_first";
  return toToolResult({
    shape: SHAPE,
    outcome: "unknown",
    repeat,
    operation: o.operation,
    object: o.object ? objectRef(o.object) : undefined,
    code: o.code ?? "no_answer",
    message: o.message,
    read_with: o.readWith,
    version_argument: g?.version?.arg,
  }, {
    summary: o.summary,
    notes: o.notes,
    keyArgument: g?.idempotencyKey?.arg,
    key: g?.idempotencyKey?.value,
    sentVersion: g?.version?.value,
  }, o.own);
}

/** Thrown by a write callback when the backend refused the write: nothing was applied. */
export class NotAppliedError extends Error {
  override readonly name = "NotAppliedError";
  constructor(message: string, readonly detail: { code?: string; object?: { type?: string; id?: Scalar }; argument?: string } = {}) {
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
 *   "refused"   the backend refused it (a NotAppliedError): settled, nothing applied
 *   "not_sent"  the request was never sent (connection refused, name not resolved)
 *   "unknown"   the request may have been sent and no answer arrived, or the error is not
 *               recognised (the cautious reading: never report "not applied" when unsure)
 */
export type ErrorClass = "refused" | "not_sent" | "unknown";

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

/** Error codes and names meaning the request may have been sent and its answer was lost. */
const LOST_ANSWER_CODES = new Set(["ETIMEDOUT", "ECONNRESET", "ECONNABORTED", "EPIPE", "UND_ERR_SOCKET", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "ABORT_ERR"]);
const LOST_ANSWER_NAMES = new Set(["TimeoutError", "AbortError"]);

/**
 * The code for an unknown outcome caused by `e`: "no_answer" (fixed by B-9: a request was sent and
 * no answer arrived) only where the error says so (an OutcomeUnknownError, a timeout, a reset or
 * closed connection), anywhere in its `cause` chain; otherwise "internal_error", a server code for
 * a handler that failed after it may have written.
 */
export function unknownCode(e: unknown): string {
  let cur: unknown = e;
  for (let i = 0; i < 4 && cur && typeof cur === "object"; i++) {
    if (cur instanceof OutcomeUnknownError) return "no_answer";
    const c = (cur as { code?: unknown }).code;
    if (typeof c === "string" && LOST_ANSWER_CODES.has(c)) return "no_answer";
    const n = (cur as { name?: unknown }).name;
    if (typeof n === "string" && LOST_ANSWER_NAMES.has(n)) return "no_answer";
    cur = (cur as { cause?: unknown }).cause;
  }
  return "internal_error";
}

/** Classifies an error thrown while sending a write. See ErrorClass. */
export function classifyError(e: unknown): ErrorClass {
  if (e instanceof NotAppliedError) return "refused";
  if (e instanceof OutcomeUnknownError) return "unknown";
  const code = codeOf(e);
  if (code && NOT_SENT_CODES.has(code)) return "not_sent";
  return "unknown";
}

export interface GuardWriteOptions {
  /** The read that settles an unknown outcome. */
  readWith: ReadWith;
  /** The object, for the result. */
  object?: { type?: string; id?: Scalar; scope?: Scalar };
  operation?: string;
  /** One sentence for an unknown outcome, e.g. `the update to note "n-3" was sent and no answer arrived`. */
  what: string;
  /** The sentence where the error does not say that an answer was lost (code "internal_error"). Default: `what`. */
  whatOnError?: string;
  /** What guards a repeat of this call, where anything does. */
  guard?: RepeatGuard;
}

/**
 * Runs a write and turns a thrown error into a truthful result: a NotAppliedError becomes
 * `not_applied` with its code; a request that was never sent becomes `not_applied` with code
 * `not_sent` and `repeat: "yes"`; anything else becomes `unknown`, with code `no_answer` for a
 * timeout or a lost connection and `internal_error` for any other error (see unknownCode). The raw
 * error message is never copied into the result (a client error can carry a URL with a token,
 * MWS-SEC-1); a NotAppliedError's message is, because the caller wrote it for this purpose.
 */
export async function guardWrite(write: () => Promise<CallToolResult>, o: GuardWriteOptions): Promise<CallToolResult> {
  try {
    return await write();
  } catch (e) {
    const k = classifyError(e);
    if (k === "refused") {
      const d = (e as NotAppliedError).detail;
      return notApplied({ summary: (e as Error).message, code: d.code, argument: d.argument, object: d.object ?? o.object, operation: o.operation });
    }
    if (k === "not_sent") {
      return notApplied({ summary: "the backend could not be reached, so the request was not sent", code: "not_sent", repeat: "yes", object: o.object, operation: o.operation });
    }
    const code = codeOf(e);
    const ucode = unknownCode(e);
    return unknownOutcome({
      summary: ucode === "no_answer" ? o.what : o.whatOnError ?? o.what,
      readWith: o.readWith,
      object: o.object,
      operation: o.operation,
      guard: o.guard,
      code: ucode,
      message: e instanceof OutcomeUnknownError ? e.message : code ? `error code ${code}` : undefined,
    });
  }
}
