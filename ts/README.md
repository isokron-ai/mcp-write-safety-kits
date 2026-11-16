# @mcp-write-safety/kit

Small TypeScript helpers for the write tools of an MCP server. They cover the parts of the MCP Write-Safety Requirements (MWS 0.9) that are easy to get wrong by hand: version checks, idempotency keys, strict input validation, truthful results, unknown outcomes and explicit annotations.

Using the kit helps a server meet MWS. It does not make a server conformant, and nothing in the kit says that it does. Only the tests decide: run `mcp-writecheck` (or another tester that follows the spec) against your server, and read the result per requirement and write path.

- No runtime dependency. The optional peer dependency `@modelcontextprotocol/sdk` is used for types only; the kit's own structural types also fit the 2.x SDK packages.
- Node 20 or later, ES modules.
- Apache-2.0. Not published yet; build it from this repository.

## Contents

- [Quick start](#quick-start)
- [The result shape (MWS result shape v0, provisional)](#the-result-shape-mws-result-shape-v0-provisional)
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
import { defineTool, compareAndSet, ToolSet } from "@mcp-write-safety/kit";

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
  settleWith: "get_document",
  handler: ({ id, expected_version, title }) => compareAndSet({
    id, noun: "document", expectedVersion: expected_version, readTool: "get_document",
    read: async () => { const d = await db.get(id); return d && { version: d.version, state: d }; },
    write: async () => { const d = await db.setTitle(id, title); return { version: d.version, changed: ["title"] }; },
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

## The result shape (MWS result shape v0, provisional)

Every result the kit builds for a write carries this object in `structuredContent`. Fields that are not relevant to a result are omitted.

```json
{ "mws": "result/v0",
  "outcome": "applied" | "not_applied" | "unknown",
  "safe_to_repeat": true | false,
  "object": { "id": "...", "version": "..." },
  "changed": ["field", ...],
  "applied": [ {"id": "...", "version": "..."} ],
  "failed": [ {"id": "...", "reason": "..."} ],
  "conflict": { "current_version": "...", "current_state": { ... } },
  "settle_with": "tool_name" }
```

**The shape is provisional.** It is shared with the Python kit and may change before MWS 1.0. MWS itself does not define a result shape; the requirements are about what a result says, not about its format.

| Field | Meaning |
|---|---|
| `outcome` | `applied`: the write the caller asked for is in effect. `not_applied`: it is not, in full; `applied` lists anything that remains applied. `unknown`: the server does not know. |
| `safe_to_repeat` | True when sending exactly the same call again cannot apply the write a second time and cannot undo another writer's change: a refusal that applied nothing, a write guarded by the version it carried, a write carrying an idempotency key the server honours. It says nothing about whether the repeat would succeed. |
| `object` | The object written, with its new version where the resource has one. `id` and `version` keep the JSON type the tools use, so that a caller can send them back as they are. |
| `changed` | The fields the call changed. An empty list says the call changed nothing. Left out for a delete. |
| `applied`, `failed` | For a write of several items: each item that remains applied, and each item that was not, with the reason. |
| `conflict` | For a write refused because the object changed: its current version and current state. |
| `settle_with` | The read tool that shows whether the write took effect. Always present for `unknown`. |

`isError` is true for every outcome except `applied`.

**The text block.** The kit puts one text block in `content` that mirrors the structure in plain sentences, with every value quoted or given as JSON, so that a caller that reads only the text learns the same facts. The first words are fixed by the outcome, so that a tester can declare patterns for them (spec 7.3, rule 11):

| Opening | Outcome |
|---|---|
| `Applied:` | `applied` |
| `Not applied:` | `not_applied`, nothing remains applied; the sentence ends "Nothing was changed." |
| `Not applied in full:` | `not_applied`, with items that remain applied, each listed |
| `Outcome unknown:` | `unknown`; the sentence ends "It is not known whether the change was applied." |

A replayed result (same idempotency key, same arguments) adds a line that starts `Replay:`. The shape has no replay field.

## Helpers

### Version check

`compareAndSet(options)`: MWS-CONC-1, CONC-2, CONC-4, CONC-6; Annex B-2 to B-4.

The caller sends the version it read. The helper reads the current version through your `read` callback and compares before it calls your `write` callback. On a mismatch nothing is written, and the caller gets a conflict: a tool execution error (`isError: true`) that says nothing was applied, gives the current version on its own and the current state as JSON, and tells the caller to apply its change to that state or read again, not to resend its earlier values with the new version.

- `requireVersion` (default `true`): a call without a version is refused, naming the argument. A version the caller may leave out makes the unchecked write the default (MWS-CONC-2 guidance). Set it to `false` only for a field patch whose fields are independent.
- `override` and `overrideArg`: an explicit override argument whose default is off (such as `force: true`). It applies only when no version was sent; a version that was sent is always checked (MWS-CONC-1).
- `VersionConflictError`: throw it from `write` when the backend's own precondition refused the write (an ETag with `If-Match`, Annex B-2). The helper returns the same conflict.
- `conflictState`: trims the state put in a conflict (leave out large and secret fields).
- `lock`: calls for the same object are serialized inside the process by default (Annex B-4). This closes the window between the comparison and the write for writers in one process only. Where other writers reach the backend directly, the comparison is best-effort (Annex B-3): pass the version to the backend as well, or say in the tool's description that stale writes are detected only on a best-effort basis (MWS-CONC-5).
- A `write` callback that throws anything else gives an unknown outcome that names `readTool`, and says a repeat with the same version is safe.

### Retry keys

`withIdempotency(options, write)`, `MemoryIdempotencyStore`, `IdempotencyStore`: MWS-RETRY-1, RETRY-2; Annex B-5.

```ts
handler: (args) => withIdempotency({ store, scope: "create_note", args, settleWith: "list_notes" }, async () => {
  const n = await db.createNote(args);
  return applied({ summary: `created note ${q(n.id)}`, object: { id: n.id, version: n.version }, changed: ["title"], safeToRepeat: true });
}),
```

- The same key with the same arguments returns the first call's result, with `changed: []` and a `Replay:` line, and applies nothing new.
- The same key with different arguments is refused; nothing is applied.
- Two calls with the same key at the same time never both write. The second waits for the first and then gets its result (`concurrent: "wait"`, the default), or is refused as still in progress (`concurrent: "refuse"`).
- A first call that applied nothing releases its key, so a later call with the key is a new attempt. A first call whose outcome is unknown (or that threw) keeps the key: a repeat applies nothing and says the outcome is not known, naming the read that settles it.
- Arguments are compared by a SHA-256 of their canonical JSON, without the key.
- `idempotencyKeyProperty({ ttlMs })` gives the argument's schema, with a description that tells the caller to send the same key when retrying the same intended write and says how long keys are remembered (MWS-RETRY-1 guidance).

**Production needs a durable store.** `MemoryIdempotencyStore` keeps keys in one process: they are lost on a restart and are not shared between instances. A repeat after a restart is then applied again, which MWS-RETRY-2 step (e) detects. Implement `IdempotencyStore` over your database: `begin` must look the key up and record it as in progress in one atomic step, and the record should be written in the same transaction as the write where the backend allows it (Annex B-5). Where the backend has its own idempotency key, pass the key to it as well.

### Strict inputs

`strictInput(schema)`, `withStrictInput(schema, handler)`, `validateArguments`, `inputError`: MWS-IN-1, IN-2, IN-3, IN-4, IN-6, IN-7.

The validator enforces the tool's own JSON Schema, so the schema the tool advertises is the schema it enforces. It never converts and never drops:

- a value of another type is refused (`"5"` for an integer, `"false"` for a boolean, `null` for an argument not typed `null`): MWS-IN-1, IN-6;
- an argument the schema does not define is refused, with the nearest defined name where there is one: MWS-IN-2, IN-7. The advertised schema gets `additionalProperties: false` at every object level that does not set it;
- a value that breaks `required`, `enum`, `const`, a numeric bound, `multipleOf`, a length, `pattern`, an item or property count or `uniqueItems` is refused: MWS-IN-3.

Every refusal is a tool execution error that names the argument, what was expected and what was sent, and says that nothing was changed (MWS-IN-4):

```
Not applied: argument "priority" was refused: expected integer, got string "5". Nothing was changed.
```

The validator supports a fixed subset of JSON Schema (`SUPPORTED_KEYWORDS`). A schema that uses any other keyword (`anyOf`, `$ref`, `if`, `patternProperties`, ...) is refused with `SchemaError` when the tool is defined: a keyword the validator ignored would be a constraint the tool advertises and does not enforce. zod is not needed; a zod schema can be converted to JSON Schema first if it stays within the subset.

### Result builder

`applied`, `notApplied`, `partial`, `conflict`, `toToolResult`, `renderText`, `readResult`, `q`: MWS-RES-1, RES-2, RES-3, RES-4, ATOM-1, CONC-4, CONC-6.

- `applied({ summary, object, changed, safeToRepeat })`: a success receipt with the object's id, its new version and the fields changed (MWS-RES-3, RES-4). Use it only when the state the caller asked for is in effect (MWS-RES-1). For a no-op, pass `changed: []`.
- `notApplied({ summary, failed })`: a refusal (`isError: true`) for a backend refusal, a rule of the tool or a missing object (MWS-RES-2).
- `partial({ summary, applied, failed })`: a multi-item write not applied in full. Never a success; it names each item applied and each item not applied, including items not attempted (MWS-ATOM-1). With nothing applied it is a plain refusal.
- `conflict({ id, currentVersion, currentState, readTool, versionArg })`: see [Version check](#version-check).
- `q(value)` quotes a value for a sentence (as JSON), so that each value can be read only one way. Use it in every `summary`.

`assertShape` checks the shape's invariants (an unknown outcome names `settle_with`, an applied result has no failed items, a conflict is `not_applied`); every builder calls it.

### Unknown outcomes

`unknownOutcome(options)`, `guardWrite(write, options)`, `classifyError`, `NotAppliedError`, `OutcomeUnknownError`: MWS-RES-2.

When the backend's answer is lost (a timeout, a closed or reset connection), the server does not know whether the write was applied. Saying that it failed invites a duplicate; saying that it succeeded may be false. `unknownOutcome` returns a tool execution error with `outcome: "unknown"` that:

- says it is not known whether the change was applied;
- names the read tool that settles it (`settle_with`, required);
- says whether the same call is safe to repeat. It invites a repeat only with the idempotency key or the version the call carried (`guard`); otherwise it tells the caller to read first. MWS-RES-2 forbids telling the caller to repeat a write whose outcome is open on any other terms.

`guardWrite` runs a write and turns a thrown error into a truthful result: a `NotAppliedError`, or a request that was never sent (connection refused, name not resolved), becomes `not_applied`; anything else, including an error it does not recognise, becomes `unknown`. The raw error message is never copied into the result, because a client error can carry a URL with a token (MWS-SEC-1). Report an outcome the server has established as what it is: an answer the backend gave is a settled outcome, and MWS-RES-2 forbids reporting it as unknown.

### Annotations

`writeHints(options)`, `readOnlyHints(options)`, `annotationProblems(tools, writeTools)`: MWS-ANN-1 to ANN-4.

Both helpers declare all four hints, every time, starting from the cautious values of the MCP schema: `readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: false`, `openWorldHint: true` (MWS-ANN-4). An optimistic value is a claim that MWS-ANN-1 to ANN-3 test against what the tool does, so it is set only where you pass it:

- `destructive: false` only for a tool that never deletes and never removes or replaces data the caller did not name (MWS-ANN-2), and only adds (MWS-ANN-5);
- `idempotent: true` only for a tool that has no further effect when called again with the same arguments (MWS-ANN-3);
- `readOnlyHints()` only for a tool that changes nothing (MWS-ANN-1).

`annotationProblems` lists tools without all four hints, and write tools that declare `readOnlyHint: true`; run it at start-up or in a test. Enforce a read-only mode from the server's own list of write tools (`ToolSet.writeTools()`), never from the annotations (MWS-CFG-3).

### defineTool and ToolSet

`defineTool(spec)` puts the pieces together for one tool: the advertised definition (closed schema, explicit hints) and a `call` that validates the arguments before the handler runs and, for a write tool, turns a thrown error into a truthful result naming `settleWith`. `ToolSet` serves `tools/list` (in a stable order) and `tools/call`, and refuses duplicate names.

## When the action says a requirement was violated

The table points from a `violated` record of `mcp-writecheck` (or its GitHub Action) to the helper that addresses it. Using the helper does not settle the record; run the test again.

| Action says violated | Use | Notes |
|---|---|---|
| MWS-CONC-1 | `compareAndSet` with `override` and `overrideArg` | The override must be off by default. Pass the version on to the backend's own check where there is one. |
| MWS-CONC-2 | `compareAndSet` (keep `requireVersion: true`) | Return the version from every read tool, and accept it on every whole-object write and delete. |
| MWS-CONC-3 | `compareAndSet`; send only the fields that changed | Lost updates usually come from a read-merge-write of the whole object (Annex B-1). |
| MWS-CONC-4 | `conflict` (returned by `compareAndSet`) | `isError: true`, "Nothing was changed". |
| MWS-CONC-5 | your tool description | Say that stale writes are not detected, or detected only on a best-effort basis. |
| MWS-CONC-6 | `conflict` with `currentState` | The current version on its own and the current state as JSON. |
| MWS-RES-1 | `applied` only after the state is in effect; `changed: []` for a no-op | A field the backend skipped is not changed. |
| MWS-RES-2 | `notApplied`, `partial`, `unknownOutcome`, `guardWrite` | Every failure is `isError: true`; a lost answer is `unknown`, never "failed". |
| MWS-RES-3 | `applied({ object })`, `partial({ applied })` | Return the identifier even when a later step fails. |
| MWS-RES-4 | `applied({ object: { id, version }, changed })` | |
| MWS-ATOM-1 | `partial` | Name every item applied and every item not applied. |
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

`examples/notes-server` is a small MCP server over an in-memory store (notebooks and notes, a list field, a bulk delete), built only with the kit and the 1.x SDK. Its `writecheck.yaml` is the manifest for `mcp-writecheck`, and its README records the results of a run. `.github/workflows/mws.yml` runs the mcp-writecheck GitHub Action on it.

## Develop

```sh
npm ci
npm test                                   # builds, then node --test over dist/test
cd examples/notes-server && npm ci && npm test
```

## Licence

Apache-2.0; see `LICENSE` and `NOTICE`. The requirement IDs are from the MCP Write-Safety Requirements, version 0.9, Joshua Bryan, IsoKron, CC BY 4.0.
