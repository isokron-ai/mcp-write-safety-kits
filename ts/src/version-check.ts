// Version check: a compare-and-set wrapper (MWS-CONC-1, CONC-2, CONC-4, CONC-6; Annex B-2 to B-4).
//
// The caller sends the version it read. Before the write, the helper reads the object's current
// version through a callback and compares. On a mismatch nothing is written, and the caller gets a
// conflict: a tool execution error with `code: "conflict"`, `repeat: "read_first"`, the current
// version on its own and the current state as JSON (write-result/0.1, `conflict`). On a match the
// write callback runs and its receipt is returned.
//
// Where the backend has its own version check (an ETag with If-Match, a revision precondition),
// pass the version through to it as well (Annex B-2) and throw VersionConflictError from the write
// callback when the backend refuses: the helper turns it into the same conflict. The comparison in
// the server alone is best-effort (Annex B-3) for writers that reach the backend another way; the
// per-object lock below (Annex B-4) closes the window for writers inside one server process only.
// Say so in the tool's description where the backend has no check of its own (MWS-CONC-5).

import { applied, conflict, notApplied, pointer, q, type ReadWith, type Scalar } from "./result.js";
import { guardWrite } from "./outcome.js";
import { inputError } from "./strict-input.js";
import type { CallToolResult, MaybePromise } from "./types.js";

/** The object as it is now. */
export interface Current<S> {
  version: Scalar;
  state: S;
}

/** What the write callback reports. */
export interface WriteReceipt {
  /** The object's version after the write. */
  version?: Scalar;
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
  id: Scalar;
  /** The kind of object, for `object.type` and sentences ("note"). Default "object". */
  type?: string;
  /** The kind of write: "update" (default), "delete", or a command name. */
  operation?: string;
  /** The version the caller sent (undefined where it sent none). */
  expectedVersion: Scalar | undefined;
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
  /** "backend" where the version is the backend's own (default), "server" where the server derives it (B-3). */
  versionSource?: "backend" | "server";
  /** The read that returns the object, e.g. { tool: "get_note", arguments: { id } }. */
  readWith: ReadWith;
  /** Reads the object as it is now; undefined where it does not exist. */
  read(): MaybePromise<Current<S> | undefined>;
  /** Writes. Called only when the versions match (or the override applies). */
  write(current: Current<S>): MaybePromise<WriteReceipt>;
  /**
   * The state to put in a conflict: only fields the caller may read through the read tool, never
   * a secret. Return `omitted` with the JSON Pointers of the fields left out. Default: the state as
   * read, with nothing omitted.
   */
  conflictState?(state: S): { state: Record<string, unknown>; omitted?: string[] };
  /** One sentence for the receipt, without the opening word: `updated note "n-3"`. Quote values with q(). */
  summary?(receipt: WriteReceipt): string;
  /** Compares versions. Default: equality after converting both to strings. */
  equals?(a: Scalar, b: Scalar): boolean;
  /** Per-object lock (default: one lock shared by every call of this module); false for none. */
  lock?: KeyedMutex | false;
}

const sameVersion = (a: Scalar, b: Scalar) => String(a) === String(b);

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
    }], { code: "version_required", object: { type, id: o.id }, operation });
  }
  const object = { type, id: o.id };
  const conflictFor = (cur: Current<S>, source: "backend" | "server"): CallToolResult => {
    const c = o.conflictState ? o.conflictState(cur.state) : { state: cur.state as unknown as Record<string, unknown> };
    return conflict({
      id: o.id, type, operation, currentVersion: cur.version, versionSource: source,
      currentState: c.state, omitted: c.omitted, versionArgument: arg, readWith: o.readWith,
    });
  };
  const run = async (): Promise<CallToolResult> => {
    const cur = await o.read();
    if (!cur) return notApplied({ summary: `${type} ${q(String(o.id))} was not found`, code: "not_found", object, operation, readWith: o.readWith });
    if (o.expectedVersion !== undefined && !(o.equals ?? sameVersion)(o.expectedVersion, cur.version)) {
      return conflictFor(cur, o.versionSource ?? "backend");
    }
    return guardWrite(async () => {
      try {
        const r = await o.write(cur);
        return applied({
          summary: o.summary ? o.summary(r) : `${operation === "delete" ? "deleted" : "wrote"} ${type} ${q(String(o.id))}`,
          operation,
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
      what: `the ${operation} of ${type} ${q(String(o.id))} was sent and no answer arrived`,
      guard: o.expectedVersion !== undefined ? { version: { arg, value: o.expectedVersion } } : undefined,
    });
  };
  const lock = o.lock === false ? null : o.lock ?? defaultMutex;
  return lock ? lock.run(`${type}:${String(o.id)}`, run) : run();
}
