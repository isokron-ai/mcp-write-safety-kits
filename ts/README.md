# @mcp-write-safety/kit

Small TypeScript helpers for the write tools of an MCP server. They cover the parts of the MCP Write-Safety Requirements (MWS 0.9) that are easy to get wrong by hand: version checks, idempotency keys, strict input validation, truthful results, unknown outcomes and explicit annotations.

Using the kit helps a server meet MWS. It does not make a server conformant, and nothing in the kit says that it does. Only the tests decide: run `mcp-writecheck` (or another tester that follows the spec) against your server, and read the result per requirement and write path.

- No runtime dependency. The kit does not import an MCP SDK: its own structural types fit the results of the 1.x SDK (`@modelcontextprotocol/sdk`, declared as an optional peer dependency) and of the 2.x SDK packages.
- Node 20 or later, ES modules.
- Apache-2.0. Not published yet; build it from this repository.

## Contents

- [Quick start](#quick-start)
- [The result shape (write-result/0.1)](#the-result-shape-write-result01)
- [Helpers](#helpers)
  - [Version check](#version-check)
  - [Retry keys](#retry-keys)
  - [Strict inputs](#strict-inputs)
  - [Result builder](#result-builder)
  - [Unknown outcomes](#unknown-outcomes)
  - [Annotations](#annotations)
  - [defineTool and ToolSet](#definetool-and-toolset)
- [When the action says a requirement was violated](#when-the-action-says-a-requirement-was-violated)
- [What the kit does not cover](#what-the-kit-does-not-cover)
- [Example and CI](#example-and-ci)
- [Develop](#develop)

## Quick start

Wrap a write handler: strict inputs and explicit annotations come from `defineTool`, the version check and the receipt from `compareAndSet`.

```ts
import { defineTool, compareAndSet, outputSchemaFor, ToolSet } from "@mcp-write-safety/kit";

const updateTitle = defineTool<{ id: string; expected_version: number; title: string }>({
  kind: "write",
  name: "update_title",
  description: "Sets a document's title. Requires expected_version; a stale version is refused with a conflict.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string" },
      expected_version: { type: "integer", minimum: 1 },
      title: { type: "string", minLength: 1, maxLength: 200 },
    },
    required: ["id", "expected_version", "title"],
  },
  hints: { destructive: true, idempotent: true, openWorld: false },
  readWith: ({ id }) => ({ tool: "get_document", arguments: { id } }),
  outputSchema: outputSchemaFor(),
  handler: ({ id, expected_version, title }) => compareAndSet({
    id, type: "document", expectedVersion: expected_version, readWith: { tool: "get_document", arguments: { id } },
    read: async () => { const d = await db.get(id); return d && { version: d.version, state: d }; },
    write: async () => { const d = await db.setTitle(id, title); return { version: d.version, changed: ["/title"] }; },
    conflictFields: ["id", "title", "version"],   // what a conflict may show; without it, none of the state
  }),
});

const tools = new ToolSet([updateTitle /*, ... */]);
// tools/list  -> tools.list()
// tools/call  -> tools.call(name, args)   (throws UnknownToolError for an unknown name)
```

With the 1.x SDK's low-level `Server`:

```ts
server.setRequestHandler(ListToolsRequestSchema, async () => tools.list());
server.setRequestHandler(CallToolRequestSchema, async (req) => tools.call(req.params.name, req.params.arguments));
```

Every helper can also be used on its own inside an existing handler. `examples/notes-server` is a complete server built only with the kit.

## The result shape (write-result/0.1)

Every result the kit builds for a write carries the write-result shape, version 0.1, as the member `mws` of `structuredContent`. The tool's own output, if any, sits beside it. The shape is the one in MWS 0.9, Annex B, B-9 (text approved 16 November 2026). MWS does not require it: a server can meet every requirement without it, and a result that carries it is judged by the same requirements as one that does not.

```json
{ "mws": {
    "shape": "write-result/0.1",
    "outcome": "not_applied",
    "repeat": "read_first",
    "code": "conflict",
    "message": "note \"n-3\" changed since version 2.",
    "object": { "type": "note", "id": "n-3" },
    "conflict": { "current_version": 3, "checked_by": "server", "current_state": { "title": "Docs", "tags": ["content", "v3"] } },
    "read_with": { "tool": "get_note", "arguments": { "id": "n-3" } },
    "version_argument": "expected_version" } }
```

`shape` and `outcome` are required; every other member is optional and is left out when it does not apply (never `null`).

| Member | Meaning |
|---|---|
| `outcome` | `applied` (in effect), `not_applied` (no change remains), `partial` (some items applied, some not, all settled), `unknown` (some part open), `accepted` (only for an operation the backend completes asynchronously; no `changed`, no `object.version`). `isError` is true for `not_applied`, `partial` and `unknown`. |
| `repeat` | `no`, `yes` (only with `not_applied`), `same_key`, `same_version`, `read_first`. After `applied`: `same_key` where the call carried an idempotency key, `same_version` where it carried a version, otherwise `no`. Every conflict: `read_first`. |
| `operation` | `create`, `update`, `delete` or a command name. |
| `object` | `type`, `id`, `version` (after the write; left out on a refusal), `scope` (as the scope argument names it), `parent` (`type`, `id`, `version` of the object written inside, such as the ticket of a comment). |
| `changed` | JSON Pointers into the object as the read tool returns it. `[]` says nothing changed; absent says nothing. A create lists the fields the call set (no server-managed fields, defaults or scope argument), or `""`; a delete leaves it out. |
| `replayed` | `true`: this call applied nothing itself; the answer describes an earlier call with the same idempotency key. |
| `items`, `applied_count` | One entry per item or step: `index` (a list the call gave), `step`, or `id` (an object a selector matched), with `outcome` (`applied`, `not_applied`, `not_attempted`, `unknown`), `version`, `code`, `message` and a per-item `conflict`. With `partial` or `unknown`, every item is listed. |
| `code`, `message`, `argument`, `argument_errors` | A stable code, the reason in words, a JSON Pointer to one refused argument, and every refused argument with its own code and message. |
| `conflict` | `current_version` (left out where there is none), `checked_by` (`backend` where the backend's check refused, `server` where the server compared), `current_state` (only fields the caller may read, never a secret), `omitted`, `held_by`. A refusal over several objects puts a `conflict` in each item instead. |
| `read_with` | `{ tool, arguments }`: a read tool that shows the current state. For a create whose answer was lost there is no id: the read is a list or search that finds the object (a read by key is better where the store has one). |
| `version_argument` | The write tool's argument that takes the version. |

**Identifiers and versions** are a string or an integer (within 2^53-1), in the JSON type the write tool's argument for them accepts, so that a caller can pass them on unchanged. The kit does not convert them.

**The 13 reserved codes** (`RESERVED_CODES`), each with its outcome: `conflict`, `locked`, `version_required`, `invalid_argument`, `not_found`, `idempotency_key_reused`, `unavailable`, `not_sent` (`not_applied`); `in_progress`, `key_not_known`, `no_answer`, `backend_error`, `internal_error` (`unknown`). A server may define its own codes in the same form. `version_required` takes precedence over `invalid_argument`.

**Checked before it is returned.** Every builder runs `assertShape` (values, types, and the combinations B-9 rules out, such as a reserved code with the wrong outcome or `repeat: "yes"` after `applied`). A shape that fails is not returned: the kit fails closed with an `internal_error` result (`unknown`, `read_first`), because client libraries often reject a whole result whose structured content does not match the tool's `outputSchema`.

**Reading it.** `readResult` follows B-9's reader rules: before 1.0 only version 0.1 is read; members it does not know, or whose value has the wrong form, are dropped; the other members are still read where `outcome` is missing or malformed.

**The text blocks.** Every result has two text blocks. The first is generated from the shape: a sentence that opens with the outcome (`Applied:`, `Not applied:`, `Partly applied:`, `Outcome unknown:`, `Accepted:`), the repeat instruction and the read to make. It never restates `current_state`. The second is exactly `JSON.stringify(structuredContent)`. `test/golden/first-sentence.json` pins the first block for given shapes; the Python kit is to read the same fixtures. A replay also carries `_meta: {"mws/replay": true}`, which is not result content and decides nothing.

**Read tools.** The shape is for write tools. The kit also puts it on a read tool's refusal of its input (`not_applied`, `invalid_argument`), as B-9 allows.

**The schema.** `schema/write-result-0.1.schema.json` (also `WRITE_RESULT_SCHEMA`) is the JSON Schema of the `mws` member. It is the spec's own file (`spec/shapes/write-result-0.1.schema.json`), licensed CC BY 4.0, and is byte-identical to the Python kit's copy. `outputSchemaFor({ properties, required })` builds a write tool's `outputSchema` as B-9 advises: `mws` required, the shape inlined under `$defs` (with its own `$defs` hoisted so its references resolve), the tool's own members required only where `outcome` is `applied` (`if`/`then`; a validator without `if` treats them as optional), and never `additionalProperties: false` on `mws` or its members.

## Helpers

### Version check

`compareAndSet(options)`: MWS-CONC-1, CONC-2, CONC-4, CONC-6; Annex B-2 to B-4.

The caller sends the version it read. The helper reads the current version through your `read` callback and compares before it calls your `write` callback. On a mismatch nothing is written, and the caller gets a conflict: a tool execution error with `code: "conflict"`, `repeat: "read_first"`, `conflict.current_version` on its own, `read_with` and `version_argument`, and `conflict.current_state` where you declared which fields it may carry (`conflictFields`). Its text tells the caller to build the write again from that state or read again, not to resend its earlier values with the new version.

- `requireVersion` (default `true`): a call without a version is refused with `code: "version_required"` and `argument` pointing to the version argument. A version the caller may leave out makes the unchecked write the default (MWS-CONC-2 guidance). Set it to `false` only for a field patch whose fields are independent.
- A receipt has `repeat: "same_version"` where the call carried a version; a conflict has `checked_by: "server"` (the comparison was the kit's) or `"backend"` (a `VersionConflictError`).
- `override`: the value of an explicit override argument whose default is off (such as `force: true`). It applies only when no version was sent; a version that was sent is always checked (MWS-CONC-1).
- `VersionConflictError`: throw it from `write` when the backend's own precondition refused the write (an ETag with `If-Match`, Annex B-2). The helper returns the same conflict.
- `conflictFields`: the allow-list for `current_state`: the top-level fields the caller may read through the read tool and that never hold a secret. Every other field of the state is named in `omitted`. **Without it (or `conflictState`), a conflict carries no `current_state`**: it gives `repeat: "read_first"` with `read_with`, and the caller reads the object. The kit never copies your read callback's whole state into a result by default.
- `conflictState`: builds `{ state, omitted }` yourself instead: only fields the caller may read through the read tool, never a secret, and the JSON Pointers of the fields left out. Where fields are left out, the text asks for a read before writing again.
- `lock`: calls for the same object are serialized inside the process by default (Annex B-4). This closes the window between the comparison and the write for writers in one process only. Where other writers reach the backend directly, the comparison is best-effort (Annex B-3): pass the version to the backend as well, or say in the tool's description that stale writes are detected only on a best-effort basis (MWS-CONC-5).
- A `write` callback that throws anything else gives an unknown outcome with `read_with`, and `repeat: "same_version"` where the call carried a version (`read_first` otherwise). The code is `no_answer` for a timeout or a lost connection and `internal_error` for any other error.

### Retry keys

`withIdempotency(options, write)`, `MemoryIdempotencyStore`, `IdempotencyStore`: MWS-RETRY-1, RETRY-2; Annex B-5.

```ts
handler: (args) => withIdempotency({ store, scope: "create_note", args, readWith: { tool: "list_notes", arguments: {} } }, async () => {
  const n = await db.createNote(args);
  return applied({ summary: `created note ${q(n.id)}`, operation: "create", object: { type: "note", id: n.id, version: n.version }, changed: ["/title"] });
}),
```

- Every answer to a keyed call describes the write the key identifies (B-9, "A repeat with a key"). The first answer gets `repeat: "same_key"` where it is `applied`, `accepted`, `partial` or `unknown`.
- The same key with the same arguments returns the first answer again (same `outcome`, `code`, `object`, `changed`) with `replayed: true` and `repeat: "same_key"`, and applies nothing.
- The same key with different arguments is refused (`code: "idempotency_key_reused"`, `argument: "/idempotency_key"`); nothing is applied.
- Two calls with the same key at the same time never both write. The second waits for the first (up to `waitMs`, default 10 s) and then gets its result (`concurrent: "wait"`, the default), or is answered `unknown` with `code: "in_progress"`, `replayed: true` and `repeat: "same_key"` (`concurrent: "refuse"`, or the wait ran out).
- A first call that applied nothing releases its key, so a later call with the key is a new attempt. That is a call that returned `not_applied`, or that threw a `NotAppliedError` or an error showing the request was never sent.
- A first call whose outcome is unknown, or that threw any other error, keeps the key. Its answer, and every repeat of it, is `unknown` with the first call's code (`no_answer` for a lost answer, otherwise `internal_error`), `repeat: "read_first"` and `read_with`, and says to use a new key if the read shows the write was not applied: a repeat with the same key applies nothing and only replays the open answer. A repeat has `replayed: true`. An applied, partial or accepted first result is kept and replayed with `repeat: "same_key"`.
- A store that knows a key only by name (a journal kept across a restart) returns `not_known`, answered `unknown` with `key_not_known` and `repeat: "read_first"`.
- `MemoryIdempotencyStore({ ttlMs, maxEntries })` never drops a live key to make room: a repeat with a dropped key would write again. When every slot holds a live key, a new key is refused (`code: "key_store_full"`, nothing sent) until one expires.
- Arguments are compared by a SHA-256 of their canonical JSON, without the key.
- `idempotencyKeyProperty({ ttlMs })` gives the argument's schema, with a description that tells the caller to send the same key when retrying the same intended write and says how long keys are remembered (MWS-RETRY-1 guidance).

**Production needs a durable store.** `MemoryIdempotencyStore` keeps keys in one process: they are lost on a restart and are not shared between instances. A repeat after a restart is then applied again, which MWS-RETRY-2 step (e) detects. Implement `IdempotencyStore` over your database: `begin` must look the key up and record it as in progress in one atomic step, and the record should be written in the same transaction as the write where the backend allows it (Annex B-5). Where the backend has its own idempotency key, pass the key to it as well.

### Strict inputs

`strictInput(schema)`, `withStrictInput(schema, handler)`, `validateArguments`, `inputError`: MWS-IN-1, IN-2, IN-3, IN-4, IN-6, IN-7.

The validator enforces the tool's own JSON Schema, so the schema the tool advertises is the schema it enforces. It never converts and never drops:

- a value of another type is refused (`"5"` for an integer, `"false"` for a boolean, `null` for an argument not typed `null`): MWS-IN-1, IN-6;
- an argument the schema does not define is refused, with the nearest defined name where there is one: MWS-IN-2, IN-7. The advertised schema gets `additionalProperties: false` at every object level that does not set it;
- a value that breaks `required`, `enum`, `const`, a numeric bound, `multipleOf`, a length, `pattern`, an item or property count or `uniqueItems` is refused: MWS-IN-3.

Every refusal is a tool execution error with `code: "invalid_argument"`, `argument` (a JSON Pointer) and `argument_errors` (every refused argument), and a text that names the argument, what was expected and what was sent, and says that nothing was changed (MWS-IN-4). A missing required version argument gets `version_required`, which takes precedence; the version argument is the single required argument named like `expected_version`, or the one you name (`versionArgument`):

```
Not applied: argument "priority" was refused: expected integer, got string "5". Nothing was changed.
```

The validator supports a fixed subset of JSON Schema (`SUPPORTED_KEYWORDS`). A schema that uses any other keyword (`anyOf`, `$ref`, `if`, `patternProperties`, ...), or a supported keyword with a value of the wrong form (a boolean `exclusiveMinimum`, a schema for `additionalProperties`, a `required` that is not a list of names), is refused with `SchemaError` when the tool is defined: a keyword the validator ignored would be a constraint the tool advertises and does not enforce. zod is not needed; a zod schema can be converted to JSON Schema first if it stays within the subset.

### Result builder

`applied`, `notApplied`, `itemsResult`, `accepted`, `conflict`, `toToolResult`, `renderText`, `readResult`, `q`: MWS-RES-1, RES-2, RES-3, RES-4, ATOM-1, CONC-4, CONC-6.

- `applied({ summary, operation, object, changed, readWith })`: a receipt with the object's type, id and new version and the fields changed, as JSON Pointers (MWS-RES-3, RES-4). Use it only when the state the caller asked for is in effect (MWS-RES-1). For a no-op, pass `changed: []`; for a delete, leave `changed` out. `repeat` defaults to `no`.
- `notApplied({ summary, code, argument, readWith, repeat })`: a refusal (`isError: true`) for a backend refusal, a rule of the tool or a missing object (MWS-RES-2). `repeat` defaults to `no`; use `yes` where nothing was sent or the refusal may not recur.
- `itemsResult({ summary, items, appliedCount })`: a write of several items or steps. The outcome follows from the items: `unknown` if any is unknown, `applied` if none failed, `partial` if some were applied and some not, `not_applied` if none was. Each item is named by `index` (a list the call gave), `step` or `id` (an object a selector matched) (MWS-ATOM-1). An all-or-nothing refusal is `not_applied`, with the bad item `not_applied` and its code, the rest `not_attempted`, and the top-level code taken from the bad item. A refusal over several objects puts a `conflict` in each item and none at the top level. A selector that matched nothing is `applied` with `applied_count: 0`. `repeat` defaults to `read_first` for `partial` and `unknown`; give `readWith` (or an `object` with an `id`) so that the read can be named.
- `accepted({ summary, readWith, repeat })`: only for an operation the backend completes asynchronously (NF-19). No `changed` and no `object.version`; `repeat` is `same_key` where the call carried a key, else `no`. For any other operation a tester reads `accepted` as a report that the write was made.
- `conflict({ id, type, sentVersion, currentVersion, checkedBy, currentState, omitted, readWith, versionArgument, code, heldBy })`: see [Version check](#version-check). `code: "locked"` with `heldBy` for a lock.
- `q(value)` quotes a value for a sentence (as JSON), so that each value can be read only one way. Use it in every `summary`.

`assertShape` checks the rules B-9 states (no `repeat: "yes"` except with `not_applied`, `read_first` only with `read_with` or `object.id`, every conflict `read_first`, each reserved code only with its outcome, no open item outside `unknown`, no object version on a refusal, no `changed` or object version with `accepted`, no empty or `null` `current_version`, codes in lowercase, pointers that are pointers). `toToolResult` also refuses `same_key` or `same_version` unless the text options carry the key or version the call sent. Every builder goes through `toToolResult`, which fails closed (see above). The first text block names the read wherever `read_with` is given.

### Unknown outcomes

`unknownOutcome(options)`, `guardWrite(write, options)`, `classifyError`, `NotAppliedError`, `OutcomeUnknownError`: MWS-RES-2.

When the backend's answer is lost (a timeout, a closed or reset connection), the server does not know whether the write was applied. Saying that it failed invites a duplicate; saying that it succeeded may be false. `unknownOutcome` returns a tool execution error with `outcome: "unknown"` that:

- says it is not known whether the change was applied;
- has a code (default `no_answer`; `guardWrite` gives `internal_error` where the error does not show a lost answer, and an abort is not one; `backend_error` where you pass it) and names the read that settles it (`read_with`, required);
- sets `repeat` to `same_key` or `same_version` where the call carried an idempotency key or a version that guards the repeat (`guard`), and otherwise to `read_first`. Never `yes`. MWS-RES-2 forbids telling the caller to repeat a write whose outcome is open on any other terms.

`guardWrite` runs a write and turns a thrown error into a truthful result: a `NotAppliedError`, or a request that was never sent (connection refused, name not resolved), becomes `not_applied` (the latter with `code: "not_sent"` and `repeat: "yes"`); a lost answer (a reset or closed connection, a timeout) becomes `unknown` with `no_answer`; anything else, including a crash in the server's own code, becomes `unknown` with `internal_error`. The raw error message is never copied into the result, because a client error can carry a URL with a token (MWS-SEC-1). Report an outcome the server has established as what it is: an answer the backend gave is a settled outcome, and MWS-RES-2 forbids reporting it as unknown.

### Annotations

`writeHints(options)`, `readOnlyHints(options)`, `annotationProblems(tools, writeTools)`: MWS-ANN-1 to ANN-4.

Both helpers declare all four hints, every time, starting from the cautious values of the MCP schema: `readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: false`, `openWorldHint: true` (MWS-ANN-4). An optimistic value is a claim that MWS-ANN-1 to ANN-3 test against what the tool does, so it is set only where you pass it:

- `destructive: false` only for a tool that never deletes and never removes or replaces data the caller did not name (MWS-ANN-2), and only adds (MWS-ANN-5);
- `idempotent: true` only for a tool that has no further effect when called again with the same arguments (MWS-ANN-3);
- `readOnlyHints()` only for a tool that changes nothing (MWS-ANN-1).

`annotationProblems` lists tools without all four hints, and write tools that declare `readOnlyHint: true`; run it at start-up or in a test. Enforce a read-only mode from the server's own list of write tools (`ToolSet.writeTools()`), never from the annotations (MWS-CFG-3).

### defineTool and ToolSet

`defineTool(spec)` puts the pieces together for one tool: the advertised definition (closed schema, explicit hints) and a `call` that validates the arguments before the handler runs and, for a write tool, turns a thrown error into a truthful result that gives `readWith(args)` as `read_with`. A call that leaves out the required version argument (inferred from the schema, or named with `versionArgument`) gets `code: "version_required"`. `ToolSet` serves `tools/list` (in a stable order) and `tools/call`, and refuses duplicate names.

## When the action says a requirement was violated

The table points from a `violated` record of `mcp-writecheck` (or its GitHub Action) to the helper that addresses it. Using the helper does not settle the record; run the test again.

| Action says violated | Use | Notes |
|---|---|---|
| MWS-CONC-1 | `compareAndSet` with `override` | The override must be off by default. Pass the version on to the backend's own check where there is one. |
| MWS-CONC-2 | `compareAndSet` (keep `requireVersion: true`) | Return the version from every read tool, and accept it on every whole-object write and delete. |
| MWS-CONC-3 | `compareAndSet`; send only the fields that changed | Lost updates usually come from a read-merge-write of the whole object (Annex B-1). |
| MWS-CONC-4 | `conflict` (returned by `compareAndSet`) | `isError: true`, "Nothing was changed". |
| MWS-CONC-5 | your tool description | Say that stale writes are not detected, or detected only on a best-effort basis. |
| MWS-CONC-6 | `conflict` with `currentState` | The current version on its own and the current state as JSON. |
| MWS-RES-1 | `applied` only after the state is in effect; `changed: []` for a no-op | A field the backend skipped is not changed. |
| MWS-RES-2 | `notApplied`, `itemsResult`, `unknownOutcome`, `guardWrite` | Every failure is `isError: true`; a lost answer is `unknown`, never "failed". |
| MWS-RES-3 | `applied({ object })`, `itemsResult({ items })` | Return the identifier even when a later step fails. |
| MWS-RES-4 | `applied({ object: { id, version }, changed })` | |
| MWS-ATOM-1 | `itemsResult` | Name every item applied and every item not applied. |
| MWS-ATOM-2 | your backend's transaction; validate every item before writing any (Annex B-7) | The kit reports the outcome; it cannot make a write atomic. |
| MWS-RETRY-1 | `idempotencyKeyProperty`, `withIdempotency` | |
| MWS-RETRY-2 | `withIdempotency` with a durable `IdempotencyStore` | Step (e) (restart) needs a store that survives a restart. |
| MWS-IN-1, IN-6 | `strictInput` / `defineTool` | Remove any coercion in front of the validator (SDK or validation library defaults). |
| MWS-IN-2, IN-7 | `strictInput` / `defineTool` | The advertised schema gets `additionalProperties: false`. |
| MWS-IN-3 | `strictInput` / `defineTool` | Every constraint the schema declares is enforced. |
| MWS-IN-4 | `strictInput` / `inputError` | Names the argument, what was expected and what was sent. |
| MWS-IN-5 | your input schema | Declare in the schema each fixed constraint the backend enforces. |
| MWS-ANN-1 to ANN-3, ANN-5 | `writeHints` / `readOnlyHints` | Remove the optimistic hint, or change the tool so the claim is true. |
| MWS-ANN-4 | `writeHints` / `readOnlyHints`, `annotationProblems` | |

## What the kit does not cover

- MWS-UPD-1 and UPD-2 (which fields an update touches, list elements addressed by position), MWS-TGT-1 to TGT-3 (scopes, match-all selectors, creates that overwrite), MWS-CFG-1 to CFG-4 (start-up settings) and MWS-SEC-1 (credentials in results) depend on the server's own logic. The example shows one way to meet each; the kit has no helper for them.
- MWS-RETRY-3 (`input_required` results) is not covered.
- Atomicity across several objects (MWS-ATOM-2) needs the backend's transaction.
- The in-memory idempotency store is for one process; see [Retry keys](#retry-keys).

## Example and CI

`examples/notes-server` is a small MCP server over an in-memory store (notebooks and notes, a list field, a bulk delete), built only with the kit and the 1.x SDK. Its `writecheck.yaml` is the manifest for `mcp-writecheck`, and its README records the results of a run.

The repository's CI (`.github/workflows/ts.yml` at the root) runs the kit's and the example's tests on Node 20, 22 and 24 on every push and pull request.

## Develop

```sh
npm ci
npm test                                   # builds, then node --test over dist/test
cd examples/notes-server && npm ci && npm test
```

## Licence

Apache-2.0; see `LICENSE` and `NOTICE`. The schema file `schema/write-result-0.1.schema.json` is under CC BY 4.0 (see `schema/LICENSE-schema.md`). The requirement IDs are from the MCP Write-Safety Requirements, version 0.9, Joshua Bryan, IsoKron, CC BY 4.0.

Made by [IsoKron](https://isokron.ai/?utm_source=github&utm_medium=readme&utm_campaign=mcp-write-safety-kits).
