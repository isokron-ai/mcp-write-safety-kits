// Retry keys: an idempotency-key store and a wrapper for write handlers (MWS-RETRY-1, RETRY-2;
// Annex B-5).
//
// A caller that lost an answer sends the write again. With a key, the server can tell the repeat
// from a new write:
//
//   - the same key with the same arguments returns the first call's result, marked as a replay,
//     and applies nothing new;
//   - the same key with different arguments is refused, and nothing is applied;
//   - two calls with the same key at the same time never both write: the second waits for the
//     first and then gets its result (or, with `concurrent: "refuse"`, is answered `in_progress`);
//   - where the first call's outcome is unknown (its answer from the backend was lost), a repeat
//     applies nothing and gives that answer again (`unknown`, with the first call's code).
//
// A key whose first call applied nothing (a refusal) is released, so that a corrected or later
// call with the same key is a new attempt.
//
// The in-memory store keeps keys for one server process only. Production needs a durable store
// shared by every instance of the server, written in the same transaction as the write where the
// backend allows it (Annex B-5): implement IdempotencyStore over your database. After a restart,
// an in-memory store has no record of earlier keys; the spec's restart test (MWS-RETRY-2 step (e))
// then sees a repeat applied a second time unless the backend itself deduplicates.

import { createHash, randomUUID } from "node:crypto";
import { q, readResult, toToolResult, notApplied, type ReadWith, type Repeat, type WriteResult } from "./result.js";
import { NotAppliedError, classifyError, refusalIsOpen, refusalResult, unknownCode, unknownOutcome } from "./outcome.js";
import type { CallToolResult } from "./types.js";

/** The state of a key, as `begin` finds it. */
export type BeginResult =
  /** No record: the caller may run the write. `token` must be passed to complete or release. */
  | { status: "new"; token: string }
  /** An earlier write with the same arguments: its first answer (applied, accepted, partial or unknown). */
  | { status: "replay"; result: CallToolResult }
  /** The key was used with different arguments. */
  | { status: "mismatch" }
  /** A write with this key is running. `wait`, where the store offers it, resolves when it ends. */
  | { status: "in_progress"; wait?: () => Promise<void> }
  /**
   * The store knows the key was used (for example from a journal kept across a restart) but has no
   * answer for it and cannot vouch for it. The repeat applies nothing (code "key_not_known").
   */
  | { status: "not_known" }
  /** The store cannot take another key now without forgetting a live one: nothing may be written. */
  | { status: "full" };

/** Where the server keeps its keys. Every method must be atomic per (scope, key). */
export interface IdempotencyStore {
  /** Looks the key up and, where it is new, records it as in progress, in one atomic step. */
  begin(scope: string, key: string, fingerprint: string): Promise<BeginResult>;
  /** Keep the first answer for repeats: every outcome except not_applied (unknown included, so a repeat applies nothing). */
  complete(scope: string, key: string, token: string, result: CallToolResult): Promise<void>;
  /** The write applied nothing: forget the key. */
  release(scope: string, key: string, token: string): Promise<void>;
}

type Entry = {
  fingerprint: string;
  token: string;
  state: "pending" | "done";
  result?: CallToolResult;
  expires: number;
  done: Promise<void>;
  settle: () => void;
};

export interface MemoryStoreOptions {
  /** How long a key is remembered, in milliseconds. Default 24 hours. */
  ttlMs?: number;
  /**
   * Most keys kept. Default 10,000. A live key (not yet expired) is never dropped to make room,
   * because a repeat with a dropped key would write again: when every slot holds a live key, a
   * new key is refused (code "key_store_full") until one expires.
   */
  maxEntries?: number;
  /** The clock (for tests). */
  now?: () => number;
}

/**
 * An in-memory IdempotencyStore with a time to live. For one server process, for tests and for
 * examples. It does not survive a restart and is not shared between processes.
 */
export class MemoryIdempotencyStore implements IdempotencyStore {
  readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, Entry>();

  constructor(o: MemoryStoreOptions = {}) {
    this.ttlMs = o.ttlMs ?? 24 * 60 * 60 * 1000;
    this.maxEntries = o.maxEntries ?? 10_000;
    this.now = o.now ?? Date.now;
  }

  private id(scope: string, key: string): string {
    return `${scope}\u0000${key}`;
  }

  private prune(): void {
    const t = this.now();
    for (const [k, e] of this.entries) if (e.state !== "pending" && e.expires <= t) this.entries.delete(k);
  }

  /** The number of keys held (for tests). */
  get size(): number {
    return this.entries.size;
  }

  // The body runs to completion without an await, so the look-up and the record are one step.
  async begin(scope: string, key: string, fingerprint: string): Promise<BeginResult> {
    this.prune();
    const id = this.id(scope, key);
    const e = this.entries.get(id);
    if (e && (e.state === "pending" || e.expires > this.now())) {
      if (e.fingerprint !== fingerprint) return { status: "mismatch" };
      if (e.state === "pending") return { status: "in_progress", wait: () => e.done };
      return { status: "replay", result: e.result! };
    }
    if (e) this.entries.delete(id); // expired
    if (this.entries.size >= this.maxEntries) return { status: "full" };
    let settle!: () => void;
    const done = new Promise<void>((r) => (settle = r));
    const token = randomUUID();
    this.entries.set(id, { fingerprint, token, state: "pending", expires: Number.POSITIVE_INFINITY, done, settle });
    return { status: "new", token };
  }

  private finish(scope: string, key: string, token: string, f: (e: Entry) => void): void {
    const id = this.id(scope, key);
    const e = this.entries.get(id);
    if (!e || e.token !== token) return;
    f(e);
    e.settle();
  }

  async complete(scope: string, key: string, token: string, result: CallToolResult): Promise<void> {
    this.finish(scope, key, token, (e) => Object.assign(e, { state: "done", result, expires: this.now() + this.ttlMs }));
  }

  async release(scope: string, key: string, token: string): Promise<void> {
    this.finish(scope, key, token, () => this.entries.delete(this.id(scope, key)));
  }
}

/** JSON with object keys sorted, so that equal arguments give equal text whatever their order. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(v as object).filter((k) => (v as Record<string, unknown>)[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`).join(",")}}`;
}

/** The fingerprint of a call's arguments, without the key itself. */
export function fingerprintOf(args: Record<string, unknown>, keyArg: string): string {
  const { [keyArg]: _key, ...rest } = args;
  return createHash("sha256").update(canonicalJson(rest)).digest("hex");
}

export interface IdempotencyOptions {
  store: IdempotencyStore;
  /** The scope of the keys, usually the tool name: the same key on two tools is two keys. */
  scope: string;
  /** The call's arguments (validated), including the key. */
  args: Record<string, unknown>;
  /** The argument that carries the key. Default "idempotency_key". */
  keyArg?: string;
  /** The read that shows whether a write took effect, for unknown outcomes and calls still in progress. */
  readWith: ReadWith;
  /** What a second concurrent call with the same key does: wait for the first (default) or be refused. */
  concurrent?: "wait" | "refuse";
  /** How long a second concurrent call waits for the first, in milliseconds, before it is refused as in progress. Default 10,000. */
  waitMs?: number;
  /** The fingerprint of the arguments. Default: a hash of `args` without the key (fingerprintOf). */
  fingerprint?: string;
}

/**
 * Runs a write at most once per key (MWS-RETRY-2). `write` is called only for a new key. Following
 * B-9 "A repeat with a key", the members of every answer to a keyed call describe the write the key
 * identifies:
 *
 *   - the first answer gets `repeat: "same_key"` where its outcome is applied, accepted or partial,
 *     and is kept; a `not_applied` answer releases the key;
 *   - a first answer of `unknown` (say `no_answer`) is kept with `repeat: "read_first"` and its
 *     read, and says to use a new key once the read shows nothing was applied: a repeat with the
 *     same key only ever replays it (B-9 allows `read_first` with `unknown`);
 *   - a repeat with the same arguments gets the first answer again, with `replayed: true` and the
 *     same `repeat`;
 *   - a key reused with other arguments is refused (`idempotency_key_reused`);
 *   - a repeat while the first call runs waits for it, or (`concurrent: "refuse"`) answers
 *     `unknown` with `in_progress`, `replayed: true` and `repeat: "same_key"`;
 *   - a key the store knows only by name answers `unknown` with `key_not_known`.
 *
 * A write that throws is kept as `unknown` with `internal_error` (or `no_answer` for a lost answer),
 * or releases the key where the error shows nothing was applied (a refusal or an unsent request).
 */
export async function withIdempotency(o: IdempotencyOptions, write: () => Promise<CallToolResult>): Promise<CallToolResult> {
  const keyArg = o.keyArg ?? "idempotency_key";
  const key = o.args[keyArg];
  if (key === undefined) return write();
  if (typeof key !== "string" || key.length === 0) {
    return notApplied({ summary: `argument ${q(keyArg)} was refused: expected a non-empty string, got ${q(key)}`, code: "invalid_argument", argument: keyArg });
  }
  const text = { keyArgument: keyArg, key };
  const fp = o.fingerprint ?? fingerprintOf(o.args, keyArg);
  for (;;) {
    const b = await o.store.begin(o.scope, key, fp);
    switch (b.status) {
      case "replay":
        return replayOf(b.result, keyArg, key);
      case "mismatch":
        return notApplied({
          summary: `${keyArg} ${q(key)} was already used with different arguments, so this call was refused`,
          code: "idempotency_key_reused",
          argument: keyArg,
          notes: [`A key identifies one intended write. For a different write, send a different ${keyArg}`],
        });
      case "not_known":
        return unknownOutcome({
          summary: `the server has no record of the earlier call with ${keyArg} ${q(key)} and cannot vouch for it; this call applied nothing`,
          code: "key_not_known",
          replayed: true,
          readWith: o.readWith,
          notes: [`A repeat with the same ${keyArg} applies nothing and returns this answer. If the read shows that the write was not applied, send it again with a new ${keyArg}`],
        });
      case "full":
        return notApplied({
          summary: `the server holds as many idempotency keys as it can keep, so this call was refused before anything was sent`,
          code: "key_store_full",
          repeat: "yes",
          notes: ["Send the same call again later; keys are forgotten when their time to live ends"],
        });
      case "in_progress":
        if ((o.concurrent ?? "wait") === "wait" && b.wait) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const settled = await Promise.race([
            b.wait().then(() => true),
            new Promise<boolean>((r) => { timer = setTimeout(() => r(false), o.waitMs ?? 10_000); }),
          ]);
          clearTimeout(timer);
          if (settled) continue;
        }
        return unknownOutcome({
          summary: `an earlier call with ${keyArg} ${q(key)} is still in progress; this call applied nothing`,
          code: "in_progress",
          replayed: true,
          readWith: o.readWith,
          guard: { idempotencyKey: { arg: keyArg, value: key } },
        });
      case "new": {
        let result: CallToolResult;
        try {
          result = await write();
        } catch (e) {
          const k = classifyError(e);
          if (k === "refused" && refusalIsOpen(e as NotAppliedError)) {
            // A refusal whose code B-9 reserves for an open outcome: the key is kept, as for any open answer.
            result = keyedAnswer(refusalResult(e as NotAppliedError, { readWith: o.readWith }), text);
            await o.store.complete(o.scope, key, b.token, result);
            return result;
          }
          // A refusal, or a request that was never sent, applied nothing: the key is free again.
          if (k === "refused" || k === "not_sent") {
            await o.store.release(o.scope, key, b.token);
            throw e;
          }
          // An abort is not a lost answer: only a timeout or a lost connection gives no_answer (unknownCode).
          const code = unknownCode(e);
          result = keyedAnswer(unknownOutcome({
            summary: code === "no_answer" ? `the write with ${keyArg} ${q(key)} was sent and no answer arrived` : `the write with ${keyArg} ${q(key)} stopped on a fault in the server after it may have been sent`,
            code,
            readWith: o.readWith,
          }), text);
          await o.store.complete(o.scope, key, b.token, result);
          return result;
        }
        const shape = readResult(result);
        const outcome = shape?.outcome ?? (result.isError ? "not_applied" : "applied");
        if (outcome === "not_applied") {
          await o.store.release(o.scope, key, b.token);
          return result;
        }
        const keyed = shape ? keyedAnswer(result, text) : result;
        await o.store.complete(o.scope, key, b.token, keyed);
        return keyed;
      }
    }
  }
}

/** The first sentence's summary, without the opening words and the fixed sentences after it. */
function summaryOf(result: CallToolResult): string {
  const firstText = result.content.find((c) => c.type === "text") as { text?: string } | undefined;
  const firstLine = (firstText?.text ?? "").split("\n")[0] ?? "";
  return firstLine
    .replace(/^(Applied|Not applied|Partly applied|Outcome unknown|Accepted):\s*/, "")
    .replace(/\s*(Nothing was changed\.|Some items remain applied;.*|It is not known whether the change was applied\.|The backend has not yet reported the result\.)$/, "")
    .replace(/\.$/, "");
}

/** The sentence on a keyed answer whose outcome is open: a repeat with the key only replays it. */
function openKeyNote(keyArg: string): string {
  return `A repeat with the same ${keyArg} applies nothing and returns this answer. If the read shows that the write was not applied, send it again with a new ${keyArg}`;
}

/**
 * The same result with the `repeat` B-9 gives a keyed answer, re-rendered from the shape: "same_key"
 * where the write the key identifies was applied, accepted or partly applied; "read_first" with the
 * read where its outcome is open, because a repeat with the same key only replays the open answer.
 */
function keyedAnswer(result: CallToolResult, text: { keyArgument: string; key: string }, replayed = false): CallToolResult {
  const shape = readResult(result);
  if (!shape || shape.outcome === undefined) return result;
  const { mws: _m, ...own } = result.structuredContent as Record<string, unknown>;
  const open = shape.outcome === "unknown";
  const repeat: Repeat = open && (shape.read_with || shape.object?.id !== undefined) ? "read_first" : "same_key";
  const next = { ...(shape as WriteResult), repeat, ...(replayed ? { replayed: true as const } : {}) };
  return toToolResult(next, { summary: summaryOf(result) || "the earlier call's write", ...text, notes: open ? [openKeyNote(text.keyArgument)] : undefined }, own);
}

/** The `_meta` key that also marks a replayed result (not result content; it decides nothing). */
export const REPLAY_META_KEY = "mws/replay";

/**
 * The first call's answer, given again for a repeat: the same outcome, code, object and changed,
 * with `replayed: true` and `repeat: "same_key"`, and `_meta["mws/replay"]: true`.
 */
export function replayOf(first: CallToolResult, keyArg: string, key: string): CallToolResult {
  const meta = { ...(first._meta ?? {}), [REPLAY_META_KEY]: true };
  const shape = readResult(first);
  if (!shape || shape.outcome === undefined) {
    const firstText = first.content.find((c) => c.type === "text") as { text?: string } | undefined;
    return { ...first, content: [{ type: "text", text: `Replay: an earlier call with ${keyArg} ${q(key)} and the same arguments was answered with this result; nothing was applied again.\n${firstText?.text ?? ""}` }], _meta: meta };
  }
  return { ...keyedAnswer(first, { keyArgument: keyArg, key }, true), _meta: meta };
}

export interface KeyPropertyOptions {
  /** How long the server remembers a key, in milliseconds (stated in the description). */
  ttlMs: number;
  /** Whether keys survive a restart of the server. Default false. */
  durable?: boolean;
}

/** A human-readable duration: "24 hours", "10 minutes". */
function duration(ms: number): string {
  const units: Array<[number, string]> = [[86_400_000, "day"], [3_600_000, "hour"], [60_000, "minute"], [1000, "second"]];
  for (const [n, u] of units) if (ms >= n && ms % n === 0) return `${ms / n} ${u}${ms / n === 1 ? "" : "s"}`;
  return `${ms} milliseconds`;
}

/**
 * The sentence for a tool description (MWS-RETRY-1 guidance): send the same key when retrying the
 * same intended write, and how long a key is remembered.
 */
export function idempotencyKeyDescription(o: KeyPropertyOptions): string {
  return `Optional idempotency key. When you retry the same intended write (for example after a lost answer), send the same key and the same arguments: the write is applied at most once and the repeat returns the first result. Use a new key for a different write. Keys are remembered for ${duration(o.ttlMs)}${o.durable ? "" : " by this server process, not across a restart"}.`;
}

/** The JSON Schema of an idempotency-key argument. */
export function idempotencyKeyProperty(o: KeyPropertyOptions): { type: "string"; minLength: number; maxLength: number; pattern: string; description: string } {
  return { type: "string", minLength: 8, maxLength: 128, pattern: "^[A-Za-z0-9._:-]+$", description: idempotencyKeyDescription(o) };
}

