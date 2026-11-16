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
//     first and then gets its result (or, with `concurrent: "refuse"`, is refused as in progress);
//   - where the first call's outcome is unknown (its answer from the backend was lost), a repeat
//     applies nothing and says the outcome is not known, naming the read that settles it.
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
import { q, readResult, toToolResult, notApplied, type MwsResult } from "./result.js";
import { classifyError, unknownOutcome } from "./outcome.js";
import type { CallToolResult } from "./types.js";

/** The state of a key, as `begin` finds it. */
export type BeginResult =
  /** No record: the caller may run the write. `token` must be passed to complete, release or markUnknown. */
  | { status: "new"; token: string }
  /** A completed write with the same arguments: its result. */
  | { status: "replay"; result: CallToolResult }
  /** The key was used with different arguments. */
  | { status: "mismatch" }
  /** A write with this key is running. `wait`, where the store offers it, resolves when it ends. */
  | { status: "in_progress"; wait?: () => Promise<void> }
  /** The earlier write's outcome is not known (its answer was lost). */
  | { status: "unknown" };

/** Where the server keeps its keys. Every method must be atomic per (scope, key). */
export interface IdempotencyStore {
  /** Looks the key up and, where it is new, records it as in progress, in one atomic step. */
  begin(scope: string, key: string, fingerprint: string): Promise<BeginResult>;
  /** The write was applied: keep its result for repeats. */
  complete(scope: string, key: string, token: string, result: CallToolResult): Promise<void>;
  /** The write applied nothing: forget the key. */
  release(scope: string, key: string, token: string): Promise<void>;
  /** The write's outcome is not known: keep the key so that a repeat applies nothing. */
  markUnknown(scope: string, key: string, token: string): Promise<void>;
}

type Entry = {
  fingerprint: string;
  token: string;
  state: "pending" | "done" | "unknown";
  result?: CallToolResult;
  expires: number;
  done: Promise<void>;
  settle: () => void;
};

export interface MemoryStoreOptions {
  /** How long a key is remembered, in milliseconds. Default 24 hours. */
  ttlMs?: number;
  /** Most keys kept; the oldest finished keys are dropped first. Default 10,000. */
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
    if (this.entries.size < this.maxEntries) return;
    for (const [k, e] of this.entries) {
      if (this.entries.size < this.maxEntries) break;
      if (e.state !== "pending") this.entries.delete(k);
    }
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
      if (e.state === "unknown") return { status: "unknown" };
      return { status: "replay", result: e.result! };
    }
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

  async markUnknown(scope: string, key: string, token: string): Promise<void> {
    this.finish(scope, key, token, (e) => Object.assign(e, { state: "unknown", expires: this.now() + this.ttlMs }));
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
  /** The read tool that shows whether a write took effect, for unknown outcomes. */
  settleWith: string;
  /** What a second concurrent call with the same key does: wait for the first (default) or be refused. */
  concurrent?: "wait" | "refuse";
  /** The fingerprint of the arguments. Default: a hash of `args` without the key (fingerprintOf). */
  fingerprint?: string;
}

/**
 * Runs a write at most once per key. `write` is called only for a new key; its result is kept when
 * it reports the write applied, the key is released when nothing was applied, and the key is kept
 * as "outcome unknown" when the outcome is unknown or the write threw.
 */
export async function withIdempotency(o: IdempotencyOptions, write: () => Promise<CallToolResult>): Promise<CallToolResult> {
  const keyArg = o.keyArg ?? "idempotency_key";
  const key = o.args[keyArg];
  if (key === undefined) return write();
  if (typeof key !== "string" || key.length === 0) {
    return notApplied({ summary: `argument ${q(keyArg)} was refused: expected a non-empty string, got ${q(key)}` });
  }
  const fp = o.fingerprint ?? fingerprintOf(o.args, keyArg);
  for (;;) {
    const b = await o.store.begin(o.scope, key, fp);
    switch (b.status) {
      case "replay":
        return replayOf(b.result, keyArg, key);
      case "mismatch":
        return notApplied({
          summary: `${keyArg} ${q(key)} was already used with different arguments, so this call was refused`,
          notes: [`A key identifies one intended write. For a different write, send a different ${keyArg}`],
        });
      case "unknown":
        return unknownOutcome({
          summary: `the earlier call with ${keyArg} ${q(key)} was sent and its answer was lost; this call applied nothing`,
          settleWith: o.settleWith,
          guard: { idempotencyKey: { arg: keyArg, value: key } },
        });
      case "in_progress":
        if ((o.concurrent ?? "wait") === "wait" && b.wait) {
          await b.wait();
          continue;
        }
        return notApplied({
          summary: `an earlier call with ${keyArg} ${q(key)} is still in progress; this call applied nothing`,
          settleWith: o.settleWith,
          notes: [`Read with ${q(o.settleWith)} once the earlier call has answered`],
        });
      case "new": {
        let result: CallToolResult;
        try {
          result = await write();
        } catch (e) {
          // A refusal, or a request that was never sent, applied nothing: the key is free again.
          if (classifyError(e) === "not_applied") await o.store.release(o.scope, key, b.token);
          else await o.store.markUnknown(o.scope, key, b.token);
          throw e;
        }
        const shape = readResult(result);
        const outcome = shape?.outcome ?? (result.isError ? "not_applied" : "applied");
        if (outcome === "applied") await o.store.complete(o.scope, key, b.token, result);
        else if (outcome === "unknown") await o.store.markUnknown(o.scope, key, b.token);
        else if (shape?.applied?.length) await o.store.complete(o.scope, key, b.token, result); // partly applied: replay it
        else await o.store.release(o.scope, key, b.token);
        return result;
      }
    }
  }
}

/**
 * The first call's result, marked as a replay: the same object, version and outcome, with an empty
 * list of changed fields (this call changed nothing) and a sentence that says it is a replay.
 */
export function replayOf(first: CallToolResult, keyArg: string, key: string): CallToolResult {
  const shape = readResult(first);
  const firstText = first.content.find((c) => c.type === "text") as { text?: string } | undefined;
  const firstLine = (firstText?.text ?? "").split("\n")[0] ?? "";
  const what = firstLine.replace(/^(Applied|Not applied in full|Not applied|Outcome unknown):\s*/, "").replace(/\.$/, "");
  const replaySentence = `Replay: an earlier call with ${keyArg} ${q(key)} and the same arguments was answered with this result; this call applied nothing new`;
  if (!shape) {
    return { ...first, content: [{ type: "text", text: `${replaySentence}.\n${firstText?.text ?? ""}` }] };
  }
  const replayed: MwsResult = { ...shape, ...(shape.changed ? { changed: [] } : {}) };
  return toToolResult(replayed, { summary: what || "the earlier call's write", notes: [replaySentence] });
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

