// Version check: a compare-and-set wrapper (MWS-CONC-1, CONC-2, CONC-4, CONC-6; Annex B-2 to B-4).
//
// The caller sends the version it read. Before the write, the helper reads the object's current
// version through a callback and compares. On a mismatch nothing is written, and the caller gets a
// conflict: a tool execution error with `code: "conflict"`, `repeat: "read_first"`, the current
// version on its own, the current state only where the server allow-lists its fields (otherwise
// none: the caller reads the object), and `checked_by: "server"` (the comparison was
// the server's). On a match the write callback runs and its receipt is returned, with
// `repeat: "same_version"` where the call carried a version. Versions and ids keep the JSON type
// they have (the type the tool's version argument takes); they are compared as strings.
//
// Where the backend has its own version check (an ETag with If-Match, a revision precondition),
// pass the version through to it as well (Annex B-2) and throw VersionConflictError from the write
// callback when the backend refuses: the helper turns it into the same conflict. The comparison in
// the server alone is best-effort (Annex B-3) for writers that reach the backend another way; the
// per-object lock below (Annex B-4) closes the window for writers inside one server process only.
// Say so in the tool's description where the backend has no check of its own (MWS-CONC-5).

import { applied, conflict, notApplied, pointer, q, type ReadWith, type Idv } from "./result.js";
import { guardWrite } from "./outcome.js";
import { inputError } from "./strict-input.js";
import type { CallToolResult, MaybePromise } from "./types.js";

/** The object as it is now. */
export interface Current<S> {
  version: Idv;
  state: S;
}

/** What the write callback reports. */
export interface WriteReceipt {
  /** The object's version after the write. */
  version?: Idv;
  /**
   * The fields the write changed, as JSON Pointers into the object as the read tool returns it, or
   * top-level field names (converted). An empty list says the write changed nothing (a no-op).
   * Leave it out for a delete, where "nothing changed" would be false.
   */
  changed?: string[];
}

/** Thrown by a write callback when the backend's own version check refused the write. */
export class VersionConflictError<S = Record<string, unknown>> extends Error {
  override readonly name = "VersionConflictError";
  constructor(readonly current: Current<S>) {
    super("the backend refused the write: the version does not match");
  }
}

/** Serializes async work per key, within one process (Annex B-4). */
export class KeyedMutex {
  private tails = new Map<string, Promise<void>>();

  /** Runs `fn` after every earlier `run` for the same key has finished. */
  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    const tail = prev.then(() => mine);
    this.tails.set(key, tail);
    try {
      await prev;
      return await fn();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

const defaultMutex = new KeyedMutex();

export interface CompareAndSetOptions<S> {
  /** The object's identifier. */
  id: Idv;
  /** The kind of object, for `object.type` and sentences ("note"). Default "object". */
  type?: string;
  /** The kind of write: "update" (default), "delete", or a command name. */
  operation?: string;
  /** The version the caller sent (undefined where it sent none). */
  expectedVersion: Idv | undefined;
  /**
   * Require the version (default true). With true, a call without one is refused with code
   * "version_required", naming the argument (MWS-CONC-2 guidance: a version the caller may leave
   * out makes the unchecked write the default). With false, a call without a version writes
   * unchecked, which suits only a field patch whose fields are independent (spec NF-12).
   */
  requireVersion?: boolean;
  /**
   * The value of an explicit override argument (such as `force: true`) whose default is off. When
   * it is true and no version was sent, the write runs without the check (MWS-CONC-1 allows an
   * override that is off by default). When a version was sent, the check runs regardless.
   */
  override?: boolean;
  /** The argument that takes the version. Default "expected_version". */
  versionArgument?: string;
  /** The read that returns the object, e.g. { tool: "get_note", arguments: { id } }. */
  readWith: ReadWith;
  /** Reads the object as it is now; undefined where it does not exist. */
  read(): MaybePromise<Current<S> | undefined>;
  /** Writes. Called only when the versions match (or the override applies). */
  write(current: Current<S>): MaybePromise<WriteReceipt>;
  /**
   * The allow-list for the state a conflict carries: the top-level fields the caller may read
   * through the read tool and that never hold a secret. The conflict carries those fields as
   * `current_state` and lists every other field of the state in `omitted`.
   *
   * Without `conflictFields` or `conflictState`, a conflict carries no `current_state`: it gives
   * `repeat: "read_first"` with `read_with`, and the caller reads the object (B-9). The kit never
   * copies the read callback's whole state into a result by default.
   */
  conflictFields?: string[];
  /**
   * Builds the state a conflict carries yourself, instead of `conflictFields`: only fields the
   * caller may read through the read tool, never a secret, with `omitted` naming the JSON Pointers
   * of the fields left out.
   */
  conflictState?(state: S): { state: Record<string, unknown>; omitted?: string[] };
  /** One sentence for the receipt, without the opening word: `updated note "n-3"`. Quote values with q(). */
  summary?(receipt: WriteReceipt): string;
  /** Compares versions. Default: equality after converting both to strings. */
  equals?(a: Idv, b: Idv): boolean;
  /** Per-object lock (default: one lock shared by every call of this module); false for none. */
  lock?: KeyedMutex | false;
}

const sameVersion = (a: Idv, b: Idv) => String(a) === String(b);

/** The state a conflict may carry: only what the server declared safe, else none. */
function conflictStateOf<S>(state: S, o: Pick<CompareAndSetOptions<S>, "conflictFields" | "conflictState">): { state?: Record<string, unknown>; omitted?: string[] } {
  if (o.conflictState) return o.conflictState(state);
  if (!o.conflictFields) return {};
  if (typeof state !== "object" || state === null || Array.isArray(state)) return {};
  const all = state as unknown as Record<string, unknown>;
  const allow = new Set(o.conflictFields);
  const picked = Object.fromEntries(Object.entries(all).filter(([k]) => allow.has(k)));
  const omitted = Object.keys(all).filter((k) => !allow.has(k)).map(pointer);
  return omitted.length ? { state: picked, omitted } : { state: picked };
}

/**
 * Compare-and-set. Returns a receipt, a conflict, a not-found refusal, a refusal that asks for the
 * version, or (when the write callback throws something else) an unknown outcome.
 */
export async function compareAndSet<S>(o: CompareAndSetOptions<S>): Promise<CallToolResult> {
  const type = o.type ?? "object";
  const operation = o.operation ?? "update";
  const arg = o.versionArgument ?? "expected_version";
  const requireVersion = o.requireVersion ?? true;
  if (o.expectedVersion === undefined && requireVersion && !o.override) {
    return inputError([{
      path: arg,
      pointer: pointer(arg),
      reason: `is required: send the version you read with ${q(o.readWith.tool)}`,
      expected: "the version you read",
      sent: "nothing",
    }], { versionArgument: arg, object: { type, id: o.id }, operation });
  }
  const object = { type, id: o.id };
  const conflictFor = (cur: Current<S>, checkedBy: "backend" | "server"): CallToolResult => {
    const c = conflictStateOf(cur.state, o);
    return conflict({
      id: o.id, type, operation, sentVersion: o.expectedVersion, currentVersion: cur.version, checkedBy,
      currentState: c.state, omitted: c.omitted, versionArgument: arg, readWith: o.readWith,
    });
  };
  const run = async (): Promise<CallToolResult> => {
    const cur = await o.read();
    if (!cur) return notApplied({ summary: `${type} ${q(o.id)} was not found`, code: "not_found", object, operation, readWith: o.readWith });
    if (o.expectedVersion !== undefined && !(o.equals ?? sameVersion)(o.expectedVersion, cur.version)) {
      return conflictFor(cur, "server");
    }
    return guardWrite(async () => {
      try {
        const r = await o.write(cur);
        return applied({
          summary: o.summary ? o.summary(r) : `${operation === "delete" ? "deleted" : "wrote"} ${type} ${q(o.id)}`,
          operation,
          repeat: o.expectedVersion !== undefined ? "same_version" : "no",
          sentVersion: o.expectedVersion,
          object: { type, id: o.id, ...(r.version !== undefined && operation !== "delete" ? { version: r.version } : {}) },
          changed: r.changed,
          readWith: operation === "delete" ? undefined : o.readWith,
          versionArgument: arg,
        });
      } catch (e) {
        if (e instanceof VersionConflictError) return conflictFor(e.current as Current<S>, "backend");
        throw e;
      }
    }, {
      readWith: o.readWith,
      object,
      operation,
      what: `the ${operation} of ${type} ${q(o.id)}`,
      guard: o.expectedVersion !== undefined ? { version: { arg, value: o.expectedVersion } } : undefined,
    });
  };
  const lock = o.lock === false ? null : o.lock ?? defaultMutex;
  return lock ? lock.run(`${type}:${String(o.id)}`, run) : run();
}
