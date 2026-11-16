import { test } from "node:test";
import assert from "node:assert/strict";
import { compareAndSet, KeyedMutex, VersionConflictError, readResult, type Current } from "../src/index.js";

const text = (r: { content: Array<{ type: string; text?: unknown }> }) => String(r.content[0]!.text);

type Doc = { title: string; tags: string[] };
function store() {
  const docs = new Map<string, Current<Doc>>([["d1", { version: 1, state: { title: "a", tags: ["x"] } }]]);
  const writes: string[] = [];
  const cas = (id: string, expected: number | undefined, title: string, extra: Partial<Parameters<typeof compareAndSet<Doc>>[0]> = {}) =>
    compareAndSet<Doc>({
      id, type: "doc", expectedVersion: expected, readWith: { tool: "get_doc", arguments: { id } },
      read: () => docs.get(id),
      write: (cur) => {
        const next = { version: Number(cur.version) + 1, state: { ...cur.state, title } };
        docs.set(id, next);
        writes.push(title);
        return { version: next.version, changed: ["title"] };
      },
      summary: (r) => `updated doc "${id}" to version ${r.version}`,
      ...extra,
    });
  return { docs, writes, cas };
}

test("matching version: applied, receipt with the new version and changed fields", async () => {
  const s = store();
  const r = await s.cas("d1", 1, "b");
  const sh = readResult(r)!;
  assert.equal(sh.outcome, "applied");
  assert.deepEqual(sh.object, { type: "doc", id: "d1", version: "2" });
  assert.deepEqual(sh.changed, ["/title"]);
  assert.equal(sh.operation, "update");
  assert.equal(sh.version_argument, "expected_version");
});

test("stale version: conflict, nothing written, current version and the allowed state carried", async () => {
  const s = store();
  await s.cas("d1", 1, "b");
  const r = await s.cas("d1", 1, "c", { conflictFields: ["title", "tags"] });
  assert.equal(r.isError, true);
  assert.deepEqual(s.writes, ["b"]);
  const sh = readResult(r)!;
  assert.equal(sh.outcome, "not_applied");
  assert.deepEqual(sh.conflict, { current_version: "2", version_source: "backend", current_state: { title: "b", tags: ["x"] } });
  assert.equal(sh.code, "conflict");
  assert.equal(sh.repeat, "read_first");
  assert.match(text(r), /Nothing was changed/);
});

test("by default a conflict carries no state: read_first with read_with, nothing of the read leaks", async () => {
  const docs = new Map<string, Current<{ title: string; api_token: string }>>([["d1", { version: 2, state: { title: "b", api_token: "tok-SECRET-1" } }]]);
  const r = await compareAndSet({
    id: "d1", type: "doc", expectedVersion: 1, readWith: { tool: "get_doc", arguments: { id: "d1" } },
    read: () => docs.get("d1"), write: () => ({ version: 3 }),
  });
  const sh = readResult(r)!;
  assert.deepEqual(sh.conflict, { current_version: "2", version_source: "backend" });
  assert.equal(sh.repeat, "read_first");
  assert.deepEqual(sh.read_with, { tool: "get_doc", arguments: { id: "d1" } });
  assert.doesNotMatch(JSON.stringify(r), /SECRET/);
  assert.match(text(r), /Before writing again, read it with "get_doc"/);
});

test("an allow-list carries only the listed fields and names the rest in omitted", async () => {
  const r = await compareAndSet({
    id: "d1", type: "doc", expectedVersion: 1, readWith: { tool: "get_doc", arguments: { id: "d1" } },
    read: () => ({ version: 2, state: { title: "b", api_token: "tok-SECRET-1" } }), write: () => ({ version: 3 }),
    conflictFields: ["title"],
  });
  const sh = readResult(r)!;
  assert.deepEqual(sh.conflict, { current_version: "2", version_source: "backend", current_state: { title: "b" }, omitted: ["/api_token"] });
  assert.doesNotMatch(JSON.stringify(r), /SECRET/);
});

test("versions compare as strings by default (\"2\" matches 2)", async () => {
  const s = store();
  assert.equal(readResult(await s.cas("d1", "1" as never, "b"))!.outcome, "applied");
});

test("require-version mode: a call without the version is refused, naming the argument", async () => {
  const s = store();
  const r = await s.cas("d1", undefined, "b");
  assert.equal(r.isError, true);
  assert.deepEqual(s.writes, []);
  assert.equal(readResult(r)!.code, "version_required");
  assert.equal(readResult(r)!.argument, "/expected_version");
  assert.match(text(r), /argument "expected_version" is required: send the version you read with "get_doc"/);
});

test("optional-version mode writes unchecked without a version", async () => {
  const s = store();
  const r = await s.cas("d1", undefined, "b", { requireVersion: false });
  assert.equal(readResult(r)!.outcome, "applied");
});

test("explicit override (default off) skips the check only where no version was sent", async () => {
  const s = store();
  assert.equal(readResult(await s.cas("d1", undefined, "b", { override: true }))!.outcome, "applied");
  assert.equal(readResult(await s.cas("d1", 1, "c", { override: true }))!.outcome, "not_applied", "a sent version is always checked");
});

test("missing object: not applied, names the read tool", async () => {
  const s = store();
  const r = await s.cas("nope", 1, "b");
  assert.match(text(r), /^Not applied: doc "nope" was not found/);
  assert.deepEqual(readResult(r)!.read_with, { tool: "get_doc", arguments: { id: "nope" } });
  assert.equal(readResult(r)!.code, "not_found");
});

test("a backend version refusal becomes the same conflict", async () => {
  const r = await compareAndSet<Doc>({
    id: "d", expectedVersion: 1, readWith: { tool: "get_doc", arguments: { id: "d" } }, type: "doc",
    read: () => ({ version: 1, state: { title: "a", tags: [] } }),
    write: () => { throw new VersionConflictError({ version: 5, state: { title: "z" } }); },
    conflictFields: ["title", "tags"],
  });
  assert.deepEqual(readResult(r)!.conflict, { current_version: "5", version_source: "backend", current_state: { title: "z" } });
});

test("a write that throws is an unknown outcome, safe to repeat with the version it carried", async () => {
  const r = await compareAndSet<Doc>({
    id: "d", expectedVersion: 1, readWith: { tool: "get_doc", arguments: { id: "d" } },
    read: () => ({ version: 1, state: { title: "a", tags: [] } }),
    write: () => { throw Object.assign(new Error("reset"), { code: "ECONNRESET" }); },
  });
  const sh = readResult(r)!;
  assert.equal(sh.outcome, "unknown");
  assert.equal(sh.repeat, "same_version");
  assert.equal(sh.read_with!.tool, "get_doc");
  assert.match(text(r), /same expected_version 1/);
});

test("conflictState trims the state", async () => {
  const s = store();
  await s.cas("d1", 1, "b");
  const r = await s.cas("d1", 1, "c", { conflictState: (st) => ({ state: { title: st.title }, omitted: ["tags"] }) });
  assert.deepEqual(readResult(r)!.conflict!.current_state, { title: "b" });
  assert.deepEqual(readResult(r)!.conflict!.omitted, ["/tags"]);
});

test("two concurrent writers with the same version: exactly one applies (per-object lock)", async () => {
  const docs = new Map<string, Current<Doc>>([["d", { version: 1, state: { title: "a", tags: [] } }]]);
  let applied = 0;
  const one = (title: string) => compareAndSet<Doc>({
    id: "d", expectedVersion: 1, readWith: { tool: "get_doc", arguments: { id: "d" } },
    read: async () => { await new Promise((r) => setTimeout(r, 5)); return docs.get("d"); },
    write: async (cur) => { await new Promise((r) => setTimeout(r, 5)); docs.set("d", { version: Number(cur.version) + 1, state: { ...cur.state, title } }); applied++; return { version: Number(cur.version) + 1, changed: ["title"] }; },
  });
  const rs = await Promise.all([one("x"), one("y")]);
  assert.equal(applied, 1);
  assert.deepEqual(rs.map((r) => readResult(r)!.outcome).sort(), ["applied", "not_applied"]);
});

test("KeyedMutex serializes per key and not across keys", async () => {
  const m = new KeyedMutex();
  const log: string[] = [];
  const job = (k: string, n: string, ms: number) => m.run(k, async () => { log.push(`start ${n}`); await new Promise((r) => setTimeout(r, ms)); log.push(`end ${n}`); });
  await Promise.all([job("a", "1", 20), job("a", "2", 1), job("b", "3", 1)]);
  assert.ok(log.indexOf("end 1") < log.indexOf("start 2"));
  assert.ok(log.indexOf("start 3") < log.indexOf("end 1"));
});

test("a throwing job does not block the next one", async () => {
  const m = new KeyedMutex();
  await assert.rejects(m.run("k", async () => { throw new Error("x"); }));
  assert.equal(await m.run("k", async () => 1), 1);
});
