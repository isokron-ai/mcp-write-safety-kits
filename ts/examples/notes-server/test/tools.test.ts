import { test } from "node:test";
import assert from "node:assert/strict";
import { readResult, annotationProblems } from "@mcp-write-safety/kit";
import { NotesStore } from "../src/store.js";
import { buildTools } from "../src/tools.js";
import { start } from "../src/main.js";

const text = (r: { content: Array<{ type: string; text?: unknown }> }) => String(r.content[0]!.text);

function setup() {
  const store = new NotesStore();
  return { store, tools: buildTools(store) };
}

test("every tool declares all four hints, and no write tool claims read-only", () => {
  const { tools } = setup();
  assert.deepEqual(annotationProblems(tools.list().tools, tools.writeTools()), []);
});

test("update_note: receipt, then a conflict for a stale version that carries the other writer's state", async () => {
  const { tools } = setup();
  const c = readResult(await tools.call("create_note", { title: "t", tags: ["a"] }))!;
  const id = c.object!.id;
  const u = await tools.call("update_note", { id, expected_version: 1, body: "x" });
  assert.deepEqual(readResult(u), { mws: "result/v0", outcome: "applied", safe_to_repeat: true, object: { id, version: 2 }, changed: ["body"], settle_with: "get_note" });
  const stale = await tools.call("update_note", { id, expected_version: 1, status: "archived" });
  assert.equal(stale.isError, true);
  assert.equal(readResult(stale)!.conflict!.current_version, 2);
  assert.equal((readResult(stale)!.conflict!.current_state as { body: string }).body, "x");
});

test("update_note refuses a call without the version", async () => {
  const { tools } = setup();
  await tools.call("create_note", { title: "t" });
  const r = await tools.call("update_note", { id: "n-1", title: "u" });
  assert.match(text(r), /argument "expected_version" is required and was not sent/);
});

test("create_note with a key is applied once", async () => {
  const { tools, store } = setup();
  const a = await tools.call("create_note", { title: "t", idempotency_key: "key-00000001" });
  const b = await tools.call("create_note", { title: "t", idempotency_key: "key-00000001" });
  assert.equal(store.notes.size, 1);
  assert.deepEqual(readResult(b)!.object, readResult(a)!.object);
  assert.match(text(b), /Replay:/);
  const c = await tools.call("create_note", { title: "other", idempotency_key: "key-00000001" });
  assert.equal(c.isError, true);
  assert.equal(store.notes.size, 1);
});

test("delete_notes: a selector is required, and a bad id deletes nothing and names every item", async () => {
  const { tools, store } = setup();
  await tools.call("create_note", { title: "a" });
  await tools.call("create_note", { title: "b" });
  const none = await tools.call("delete_notes", { notebook: "inbox" });
  assert.equal(none.isError, true);
  assert.equal(store.notes.size, 2);
  const bad = await tools.call("delete_notes", { notebook: "inbox", ids: ["n-1", "n-99", "n-2"] });
  assert.equal(bad.isError, true);
  assert.equal(store.notes.size, 2);
  assert.deepEqual(readResult(bad)!.failed!.map((f) => f.id), ["n-1", "n-99", "n-2"]);
  const ok = await tools.call("delete_notes", { notebook: "inbox", ids: ["n-1", "n-2"] });
  assert.deepEqual(readResult(ok)!.applied!.map((x) => x.id), ["n-1", "n-2"]);
  assert.equal(store.notes.size, 0);
});

test("add_tag keeps the other tags; remove_tag removes only the named one", async () => {
  const { tools, store } = setup();
  await tools.call("create_note", { title: "t", tags: ["a", "b"] });
  await tools.call("add_tag", { id: "n-1", tag: "c" });
  await tools.call("remove_tag", { id: "n-1", tag: "a" });
  assert.deepEqual(store.getNote("n-1")!.tags, ["b", "c"]);
  const again = await tools.call("add_tag", { id: "n-1", tag: "c" });
  assert.deepEqual(readResult(again)!.changed, []);
});

test("create_notebook never overwrites", async () => {
  const { tools, store } = setup();
  await tools.call("create_notebook", { key: "work", name: "Work" });
  const r = await tools.call("create_notebook", { key: "work", name: "Other" });
  assert.equal(r.isError, true);
  assert.equal(store.notebooks.get("work")!.name, "Work");
});

test("over HTTP: initialize, tools/list and a call", async () => {
  const s = await start(0);
  try {
    const post = async (body: unknown) => {
      const r = await fetch(s.url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify(body) });
      return (await r.json()) as { result?: Record<string, unknown>; error?: { code: number } };
    };
    const init = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    assert.equal((init.result!["serverInfo"] as { name: string }).name, "notes-server");
    const list = await post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    assert.equal((list.result!["tools"] as unknown[]).length, 11);
    const call = await post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "create_note", arguments: { title: "x" } } });
    assert.equal((call.result!["structuredContent"] as { outcome: string }).outcome, "applied");
    const unknown = await post({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "nope", arguments: {} } });
    assert.equal(unknown.error!.code, -32602);
  } finally {
    await s.close();
  }
});
