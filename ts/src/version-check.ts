// Version check: a compare-and-set wrapper (MWS-CONC-1, CONC-2, CONC-4, CONC-6; Annex B-2 to B-4).
//
// The caller sends the version it read. Before the write, the helper reads the object's current
// version through a callback and compares. On a mismatch nothing is written, and the caller gets a
// conflict: a tool execution error that says nothing was applied and carries the current version
// and the current state. On a match the write callback runs and its receipt is returned.
//
// Where the backend has its own version check (an ETag with If-Match, a revision precondition),
// pass the version through to it as well (Annex B-2) and throw VersionConflictError from the write
// callback when the backend refuses: the helper turns it into the same conflict. The comparison in
// the server alone is best-effort (Annex B-3): it closes the window for writers inside one server
// process (the per-object lock below, Annex B-4) but not for writers that reach the backend another
// way. Say so in the tool's description where the backend has no check of its own (MWS-CONC-5).

import { applied, conflict, notApplied, q, type Id, type ObjectRef, type Version } from "./result.js";
import { guardWrite } from "./outcome.js";
import { inputError } from "./strict-input.js";
import type { CallToolResult, MaybePromise } from "./types.js";

/** The object as it is now. */
export interface Current<S> {
  version: Version;
  state: S;
}

/** What the write callback reports. */
export interface WriteReceipt {
  /** The object's version after the write. */
  version?: Version;
  /** The fields the write changed (an empty list for a write that changed nothing). */
  changed: string[];
  /** The object's id after the write, where it differs (rare). */
  id?: Id;
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
  id: Id;
  /** The noun for sentences ("note"). Default "object". */
  noun?: string;
  /** The version the caller sent (undefined where it sent none). */
  expectedVersion: Version | undefined;
  /**
   * Require the version (default true). With true, a call without one is refused, naming the
   * argument (MWS-CONC-2 guidance: a version the caller may leave out makes the unchecked write
   * the default). With false, a call without a version writes unchecked, which suits only a field
   * patch whose fields are independent (spec NF-12); use `override` for a whole-object write.
   */
  requireVersion?: boolean;
  /**
   * The value of an explicit override argument (such as `force: true`) whose default is off. When
   * it is true and no version was sent, the write runs without the check (MWS-CONC-1 allows an
   * override that is off by default). When a version was sent, the check runs regardless.
   */
  override?: boolean;
  /** The name of the override argument, for the error that asks for a version. */
  overrideArg?: string;
  /** The argument that takes the version. Default "expected_version". */
  versionArg?: string;
  /** The read tool that returns the object; named in a conflict and a not-found. */
  readTool: string;
  /** Reads the object as it is now; undefined where it does not exist. */
  read(): MaybePromise<Current<S> | undefined>;
  /** Writes. Called only when the versions match (or the override applies). */
  write(current: Current<S>): MaybePromise<WriteReceipt>;
  /** The compact state to put in a conflict (default: the state as read). Leave out large or secret fields. */
  conflictState?(state: S): Record<string, unknown>;
  /** One sentence for the receipt, without the opening word: `updated note "n-3"`. Default: `wrote <noun> "<id>"`. */
  summary?(receipt: WriteReceipt): string;
  /** See MwsResult.safe_to_repeat for the receipt. Default: true when a version guarded the write. */
  safeToRepeat?: boolean;
  /** Compares versions. Default: strict equality after converting both to strings. */
  equals?(a: Version, b: Version): boolean;
  /** Per-object lock (default: a lock shared by every call of this module); false for none. */
  lock?: KeyedMutex | false;
}

const sameVersion = (a: Version, b: Version) => String(a) === String(b);

/**
 * Compare-and-set. Returns a receipt, a conflict, a not-found refusal, a refusal that asks for the
 * version, or (when the write callback throws something else) an unknown-outcome error.
 */
export async function compareAndSet<S>(o: CompareAndSetOptions<S>): Promise<CallToolResult> {
  const noun = o.noun ?? "object";
  const arg = o.versionArg ?? "expected_version";
  const requireVersion = o.requireVersion ?? true;
  if (o.expectedVersion === undefined && requireVersion && !o.override) {
    return inputError([{
      path: arg,
      reason: `is required: send the version you read with ${q(o.readTool)}${o.overrideArg ? `, or set ${q(o.overrideArg)} to write without the check` : ""}`,
      expected: "the version you read",
      sent: "nothing",
    }]);
  }
  const object: ObjectRef = { id: o.id };
  const run = async (): Promise<CallToolResult> => {
    const cur = await o.read();
    if (!cur) return notApplied({ summary: `${noun} ${q(o.id)} was not found`, object, settleWith: o.readTool });
    if (o.expectedVersion !== undefined && !(o.equals ?? sameVersion)(o.expectedVersion, cur.version)) {
      return conflictFor(o, cur);
    }
    return guardWrite(async () => {
      try {
        const r = await o.write(cur);
        return applied({
          summary: o.summary ? o.summary(r) : `wrote ${noun} ${q(r.id ?? o.id)}`,
          object: { id: r.id ?? o.id, ...(r.version !== undefined ? { version: r.version } : {}) },
          changed: r.changed,
          safeToRepeat: o.safeToRepeat ?? o.expectedVersion !== undefined,
          settleWith: o.readTool,
        });
      } catch (e) {
        if (e instanceof VersionConflictError) return conflictFor(o, e.current as Current<S>);
        throw e;
      }
    }, {
      settleWith: o.readTool,
      object,
      what: `the write to ${noun} ${q(o.id)} was sent and no answer arrived`,
      guard: o.expectedVersion !== undefined ? { version: { arg, value: o.expectedVersion } } : undefined,
    });
  };
  const lock = o.lock === false ? null : o.lock ?? defaultMutex;
  return lock ? lock.run(`${noun}:${String(o.id)}`, run) : run();
}

function conflictFor<S>(o: CompareAndSetOptions<S>, cur: Current<S>): CallToolResult {
  return conflict({
    id: o.id,
    noun: o.noun,
    currentVersion: cur.version,
    currentState: o.conflictState ? o.conflictState(cur.state) : (cur.state as unknown as Record<string, unknown>),
    versionArg: o.versionArg,
    readTool: o.readTool,
  });
}
