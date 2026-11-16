import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryIdempotencyStore, withIdempotency, applied, notApplied, unknownOutcome, readResult, canonicalJson, fingerprintOf, idempotencyKeyProperty, idempotencyKeyDescription, q, type CallToolResult } from "../src/index.js";

const text = (r: { content: Array<{ type: string; text?: unknown }> }) => String(r.content[0]!.text);

function harness(store = new MemoryIdempotencyStore()) {
  let n = 0;
  const created: string[] = [];
  const create = (args: Record<string, unknown>, o: { delayMs?: number; fail?: "refuse" | "throw" | "unknown" } = {}) =>
    withIdempotency({ store, scope: "create_note", args, settleWith: "list_notes" }, async () => {
      if (o.delayMs) await new Promise((r) => setTimeout(r, o.delayMs));
      if (o.fail === "refuse") return notApplied({ summary: "notebook not found" });
      if (o.fail === "throw") throw new Error("socket closed");
      if (o.fail === "unknown") return unknownOutcome({ summary: "sent, no answer", settleWith: "list_notes" });
      const id = `n-${++n}`;
      created.push(id);
      return applied({ summary: `created note ${q(id)}`, object: { id, version: 1 }, changed: ["title"], safeToRepeat: true });
    });
  return { store, created, create };
}

test("same key, same arguments: applied once; the repeat returns the first result, marked as a replay", async () => {
  const h = harness();
  const a = await h.create({ title: "t", idempotency_key: "key-0001" });
  const b = await h.create({ idempotency_key: "key-0001", title: "t" });
  assert.deepEqual(h.created, ["n-1"]);
  const sa = readResult(a)!;
  const sb = readResult(b)!;
  assert.equal(sb.outcome, "applied");
  assert.deepEqual(sb.object, sa.object);
  assert.deepEqual(sb.changed, [], "the repeat changed nothing");
  assert.equal(b.isError, undefined);
  assert.match(text(b), /^Applied: created note "n-1"\./);
  assert.match(text(b), /Replay: an earlier call with idempotency_key "key-0001" and the same arguments/);
});

test("same key, different arguments: refused, nothing applied", async () => {
  const h = harness();
  await h.create({ title: "t", idempotency_key: "key-0002" });
  const r = await h.create({ title: "other", idempotency_key: "key-0002" });
  assert.deepEqual(h.created, ["n-1"]);
  assert.equal(r.isError, true);
  assert.equal(readResult(r)!.outcome, "not_applied");
  assert.match(text(r), /idempotency_key "key-0002" was already used with different arguments/);
});

test("a different key is a new write", async () => {
  const h = harness();
  await h.create({ title: "t", idempotency_key: "key-0003" });
  await h.create({ title: "t", idempotency_key: "key-0004" });
  assert.deepEqual(h.created, ["n-1", "n-2"]);
});

test("no key: every call writes", async () => {
  const h = harness();
  await h.create({ title: "t" });
  await h.create({ title: "t" });
  assert.equal(h.created.length, 2);
});

test("concurrent calls with the same key never write twice (the second waits and replays)", async () => {
  const h = harness();
  const rs = await Promise.all(Array.from({ length: 10 }, () => h.create({ title: "t", idempotency_key: "key-0005" }, { delayMs: 10 })));
  assert.deepEqual(h.created, ["n-1"]);
  for (const r of rs) assert.deepEqual(readResult(r)!.object, { id: "n-1", version: 1 });
  assert.equal(rs.filter((r) => /Replay:/.test(text(r))).length, 9);
});

test("concurrent calls with concurrent: refuse: the second is refused as in progress", async () => {
  const store = new MemoryIdempotencyStore();
  let n = 0;
  const call = () => withIdempotency({ store, scope: "s", args: { k: 1, idempotency_key: "key-0006" }, settleWith: "get", concurrent: "refuse" }, async () => {
    await new Promise((r) => setTimeout(r, 10));
    n++;
    return applied({ summary: "x", object: { id: 1 } });
  });
  const [a, b] = await Promise.all([call(), call()]);
  assert.equal(n, 1);
  assert.equal(readResult(a)!.outcome, "applied");
  assert.equal(b.isError, true);
  assert.match(text(b), /still in progress; this call applied nothing/);
});

test("a refused first call releases the key: the repeat is a new attempt", async () => {
  const h = harness();
  const a = await h.create({ title: "t", idempotency_key: "key-0007" }, { fail: "refuse" });
  assert.equal(readResult(a)!.outcome, "not_applied");
  const b = await h.create({ title: "t", idempotency_key: "key-0007" });
  assert.equal(readResult(b)!.outcome, "applied");
  assert.deepEqual(h.created, ["n-1"]);
});

test("an unknown first outcome: the repeat applies nothing and says the outcome is not known", async () => {
  for (const fail of ["unknown", "throw"] as const) {
    const h = harness();
    if (fail === "throw") await assert.rejects(h.create({ title: "t", idempotency_key: "key-0008" }, { fail }));
    else await h.create({ title: "t", idempotency_key: "key-0008" }, { fail });
    const r = await h.create({ title: "t", idempotency_key: "key-0008" });
    assert.deepEqual(h.created, []);
    const s = readResult(r)!;
    assert.equal(s.outcome, "unknown");
    assert.equal(s.settle_with, "list_notes");
    assert.match(text(r), /It is not known whether the change was applied/);
    assert.match(text(r), /this call applied nothing/);
  }
});

test("keys expire after the TTL", async () => {
  let now = 1000;
  const h = harness(new MemoryIdempotencyStore({ ttlMs: 50, now: () => now }));
  await h.create({ title: "t", idempotency_key: "key-0009" });
  now += 49;
  await h.create({ title: "t", idempotency_key: "key-0009" });
  assert.equal(h.created.length, 1);
  now += 2;
  await h.create({ title: "t", idempotency_key: "key-0009" });
  assert.equal(h.created.length, 2);
});

test("maxEntries drops the oldest finished keys", async () => {
  const store = new MemoryIdempotencyStore({ maxEntries: 3 });
  const h = harness(store);
  for (let i = 0; i < 6; i++) await h.create({ title: "t", idempotency_key: `key-10${i}0` });
  assert.ok(store.size <= 3);
});

test("keys are scoped: the same key on two tools is two keys", async () => {
  const store = new MemoryIdempotencyStore();
  let n = 0;
  const run = (scope: string) => withIdempotency({ store, scope, args: { a: 1, idempotency_key: "key-0010" }, settleWith: "g" }, async () => applied({ summary: `n ${++n}`, object: { id: n } }));
  await run("one");
  await run("two");
  assert.equal(n, 2);
});

test("canonical JSON and fingerprints ignore key order and the key itself", () => {
  assert.equal(canonicalJson({ b: [1, { d: 1, c: 2 }], a: null }), '{"a":null,"b":[1,{"c":2,"d":1}]}');
  assert.equal(fingerprintOf({ a: 1, b: 2, idempotency_key: "x" }, "idempotency_key"), fingerprintOf({ b: 2, a: 1, idempotency_key: "y" }, "idempotency_key"));
  assert.notEqual(fingerprintOf({ a: 1 }, "k"), fingerprintOf({ a: 2 }, "k"));
});

test("the key argument's schema and description state the retry rule and the lifetime", () => {
  const p = idempotencyKeyProperty({ ttlMs: 24 * 3600 * 1000 });
  assert.equal(p.type, "string");
  assert.match(p.description, /send the same key and the same arguments/);
  assert.match(p.description, /remembered for 1 day by this server process, not across a restart/);
  assert.match(idempotencyKeyDescription({ ttlMs: 600_000, durable: true }), /remembered for 10 minutes\.$/);
});

test("a result without the shape is still stored and replayed", async () => {
  const store = new MemoryIdempotencyStore();
  let n = 0;
  const run = () => withIdempotency({ store, scope: "s", args: { idempotency_key: "key-0011" }, settleWith: "g" }, async (): Promise<CallToolResult> => ({ content: [{ type: "text", text: `made ${++n}` }] }));
  await run();
  const b = await run();
  assert.equal(n, 1);
  assert.match(text(b), /^Replay:.*\nmade 1$/s);
});

test("a write that throws a refusal releases the key", async () => {
  const { NotAppliedError } = await import("../src/index.js");
  const store = new MemoryIdempotencyStore();
  let n = 0;
  const run = (fail: boolean) => withIdempotency({ store, scope: "s", args: { idempotency_key: "key-0012" }, settleWith: "g" }, async () => {
    if (fail) throw new NotAppliedError("refused");
    return applied({ summary: `made ${++n}`, object: { id: n } });
  });
  await assert.rejects(run(true), NotAppliedError);
  assert.equal(readResult(await run(false))!.outcome, "applied");
  assert.equal(n, 1);
});
