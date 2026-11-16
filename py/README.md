# mcp-write-safety-kit

Python helpers for the write tools of an MCP server. Wrap your write handlers with them and the hard
parts of the MCP Write-Safety Requirements (MWS 0.9) are handled by default: version checks,
idempotency keys, strict inputs, truthful results, unknown outcomes and explicit annotations.

- Package `mcp-write-safety-kit`, import `mws_kit`. Python 3.10 or later, typed (`py.typed`).
- No runtime dependency beyond the official MCP Python SDK (`mcp`). Works with the SDK's high-level
  server in both lines, `FastMCP` (1.x) and `MCPServer` (2.x), and with plain handlers on the
  low-level `Server`.
- Apache-2.0. Not published yet.

**The kit helps a server meet MWS. Using it does not make a server conformant.** MWS gives a
verdict per requirement and per write path, and only the tests decide it: run
[`mcp-writecheck`](#proof-the-example-server-and-mcp-writecheck) against your own server in a
test environment.

Results use the **write-result shape 0.1**, described in the draft Annex B-9 for MWS 0.9. It is a
draft: version 0.2 may change it, and the kit will follow.

## Contents

- [Quick start](#quick-start)
- [The result shape](#the-result-shape-write-result01)
- [Helpers](#helpers)
  - [Version check](#1-version-check)
  - [Retry keys](#2-retry-keys)
  - [Strict inputs](#3-strict-inputs)
  - [Result builders](#4-result-builders)
  - [Unknown outcomes](#5-unknown-outcomes)
  - [Annotations](#6-annotations)
  - [Wiring into the SDK](#wiring-into-the-sdk)
- [mcp-writecheck says X violated: use helper Y](#mcp-writecheck-says-x-violated-use-helper-y)
- [Proof: the example server and mcp-writecheck](#proof-the-example-server-and-mcp-writecheck)
- [What the kit does not do](#what-the-kit-does-not-do)

## Quick start

```sh
pip install -e .            # from this folder; brings the MCP Python SDK
```

```python
from mcp.server.mcpserver import MCPServer          # SDK 2.x; on 1.x: from mcp.server.fastmcp import FastMCP
from mcp.types import CallToolResult
from mws_kit import Snapshot, VersionGuard, WriteSafety, read_answer

notes = {"n-1": {"id": "n-1", "title": "Draft", "version": "1"}}

def read(note_id):
    n = notes.get(note_id)
    return None if n is None else Snapshot(dict(n), n["version"])

def write(note_id, change, expected_version):
    n = notes[note_id]
    notes[note_id] = {**n, **change, "version": str(int(n["version"]) + 1)}
    return read(note_id)

server = MCPServer("notes")
kit = WriteSafety(server)            # strict inputs for every tool registered through the kit
guard = VersionGuard(read=read, write=write, read_tool="get_note", noun="note")

@kit.read_tool(open_world=False)
def get_note(id: str) -> CallToolResult:
    return read_answer(notes[id])

@kit.write_tool(read_tool="get_note", read_arguments={"id": "id"}, destructive=True, idempotent=True, open_world=False)
def rename_note(id: str, expected_version: str, title: str) -> CallToolResult:
    return guard.apply(id, expected_version, {"title": title})
```

`rename_note` now refuses a stale version with a conflict that carries the current state, refuses
`title: 5` or a misspelled argument instead of converting or dropping it, returns a receipt naming
the changed field and the new version, declares all four annotation hints, and turns an exception
in the handler into an "outcome unknown" result that names `get_note` as the read that settles it.

## The result shape (write-result/0.1)

Every write result carries the shape as the member `mws` of `structuredContent`, beside the tool's
own output:

```json
{ "note": { "id": "n-1", "title": "Plan", "version": "2" },
  "mws": { "shape": "write-result/0.1",
           "outcome": "applied",
           "repeat": "no",
           "operation": "update",
           "object": { "type": "note", "id": "n-1", "version": "2" },
           "changed": ["/title"] } }
```

| Member | Values |
|---|---|
| `outcome` | `applied`, `not_applied`, `partial`, `unknown`, `accepted`. The kit sets `isError: true` for `not_applied`, `partial` and `unknown`. |
| `repeat` | `no`, `yes`, `same_key`, `same_version`, `read_first`. Never `yes` with `unknown`, `partial` or `accepted` (the kit refuses to build that). |
| `object` | `type`, `id`, `version`, `scope`, each a string. No `version` on `not_applied`. |
| `changed` | JSON Pointers into the object as the read tool returns it. `[]` says nothing changed; a missing member says nothing. |
| `items`, `applied_count` | One entry per item or step: `index`, `id`, `version`, `outcome` (`applied`, `not_applied`, `not_attempted`, `unknown`), `code`, `message`. |
| `code`, `message`, `argument` | A stable code (`conflict`, `locked`, `version_required`, `invalid_argument`, `no_answer`, `not_sent`, or the server's own), words, and a JSON Pointer to the refused argument. |
| `conflict` | `current_version` (left out when there is none), `version_source`, `current_state`, `omitted`, `held_by`. |
| `read_with` | `{tool, arguments}`: the read that shows the current state. |
| `replayed`, `operation`, `version_argument` | A replayed answer to a repeated idempotency key; the kind of write; the argument that takes the version. |

The content has two text blocks. The first states the outcome in plain words, opening with
"Applied:", "Not applied:", "Partly applied:", "Outcome unknown:" or "Accepted:", and gives the facts
a caller acts on, every value quoted or as JSON. The second is the serialized `structuredContent`.

**Output schema.** Each write tool registered with `kit.write_tool` advertises an `outputSchema`
(`mws_kit.output_schema`): `mws` is always required, the tool's own output members (pass their
schema as `output=`) are required only where `mws.outcome` is `applied`, and the shape's schema is
inlined under `$defs.write_result`. Results with `isError: true` therefore conform too. The shape's
schema ships as `mws_kit/write-result-0.1.schema.json` (`mws_kit.WRITE_RESULT_SCHEMA`).

How the SDK generates output schemas, and what the kit does about it: both SDK lines derive an
`outputSchema` from a handler's return annotation, and neither does so for a handler annotated
`-> CallToolResult`, which is what kit handlers return. The kit sets the schema on the registered
tool itself. SDK 1.x also validates a returned `CallToolResult` against a pydantic model whenever a
schema is set, so on 1.x the kit adds a model that accepts any object; the kit's builders check the
shape themselves (`assert_shape`). The SDK clients of both lines validate results against the
advertised schema, and the tests run them.

## Helpers

### 1. Version check

`VersionGuard` is compare-and-set around your own `read(id) -> Snapshot | None` and
`write(id, change, expected_version) -> Snapshot | None`, sync (`apply`, `delete`) or async
(`apply_async`, `delete_async`).

| Situation | Result |
|---|---|
| The version matches | `applied`, `object.version` the new version, `changed` the fields that differ (JSON Pointers) |
| It does not match, or `write` raises `VersionConflict` | `not_applied`, `code: "conflict"`, `repeat: "read_first"`, `conflict.current_version` and `current_state` (minus the fields in `omit`, listed in `omitted`), `read_with`, `version_argument` |
| No version, with `require_version=True` (the default) | `not_applied`, `code: "version_required"`, `argument: "/expected_version"` |
| `write` loses the answer (timeout, reset) | `unknown`, `code: "no_answer"`, `repeat: "same_version"` |
| The request was never sent (connection refused) | `not_applied`, `code: "not_sent"` |

Addresses **MWS-CONC-2** (refuse a stale write), **MWS-CONC-4** (a conflict is an error and nothing
is applied), **MWS-CONC-6** (the current state as JSON and the version on its own, under the name the
write tool accepts), **MWS-RES-4** (receipt), and **MWS-CONC-1** by requiring the version by default.

Where the backend can check the version (an `If-Match` precondition, a conditional update), pass
`expected_version` on in `write` and raise `VersionConflict` when it refuses: that is the reliable
form (Annex B-2). The guard's own comparison runs under a per-object lock in this process
(Annex B-3, B-4); a writer outside the process can still slip in between. If your backend cannot
check versions, say so in the tool's description (MWS-CONC-5) and set `version_source="server"`.

### 2. Retry keys

`Idempotency(store, ttl=..., wait=...)` runs a write at most once per idempotency key:
`run(scope=..., key=..., arguments=..., write=..., read_with=...)`, or `run_async`.

- The same key with the same arguments: applied once; a repeat gets the first outcome with
  `replayed: true`.
- The same key with other arguments: refused (`code: "idempotency_key_reused"`), nothing applied.
- A different key: a new write.
- Concurrent calls with one key, from threads or asyncio tasks: one writes; the others wait for its
  outcome (or, after `wait` seconds, get `unknown` with `code: "in_progress"` and
  `repeat: "same_key"`).
- A first call that applied nothing releases the key; one whose outcome is unknown keeps it, so a
  repeat applies nothing. That answer (and its replay) says `repeat: "read_first"` with the read
  that settles it, and to send the write again with a new key if the read shows it was not applied.

`IdempotencyStore` (and `AsyncIdempotencyStore`) is the protocol for your own store;
`InMemoryIdempotencyStore` keeps keys in this process with a time to live. `describe()` gives a
sentence for the tool's description. Addresses **MWS-RETRY-1** (accept a key) and **MWS-RETRY-2**
(honour it).

The in-memory store loses its keys when the process stops, and a second process does not see them
(Annex B-5). Where that matters, implement the protocol over shared, durable storage, and write the
key record in the same transaction as the write where you can.

### 3. Strict inputs

The SDK's high-level server validates arguments with a pydantic model in pydantic's default lax
mode, and ignores arguments the model does not define. By default, therefore:

- `"true"`, `"yes"` and `"1"` become `True` for a `bool`; `"5"` becomes `5` for an `int`;
- FastMCP 1.x also parses a string holding JSON (`"[1, 2]"`) for a list or object parameter;
- a misspelled argument is dropped, and the call succeeds.

`tests/test_server.py` shows each of these on the plain SDK and the refusal through the kit.
`WriteSafety(server)` checks every call to a kit tool against the tool's schema before the SDK sees
it: no conversion of any kind, unknown arguments refused (and `additionalProperties: false`
advertised), every declared constraint enforced. The refusal is `not_applied` with
`code: "invalid_argument"` and `argument` (a JSON Pointer), and the text names each argument, what
was expected and what was sent, for example `Argument "count": expected integer, got string "5"`.

The checker supports the keywords pydantic and hand-written schemas use and refuses a schema with
any other validation keyword (`UnsupportedSchema`), so it never skips a constraint. `WriteSafety(server,
strict=False)` keeps the SDK's lax behaviour. For a low-level server use `check_arguments`,
`refuse_arguments` and `strict_schema` directly.

Addresses **MWS-IN-1**, **IN-2**, **IN-3**, **IN-4**, **IN-6** and **IN-7**.

### 4. Result builders

`applied`, `accepted`, `not_applied`, `partial`, `conflict`, `unknown_outcome`, plus `item`,
`read_with` and `pointer`. Each builds the `CallToolResult` with the shape, both text blocks and the
right `isError`, and `assert_shape` refuses a result that breaks a rule of the shape (a version in
`object` on `not_applied`, `repeat: "yes"` on `unknown` or after an applied delete, `read_first`
with neither `read_with` nor `object.id`, `same_key` or `same_version` without the key or version
the call carried, an open item outside `unknown`, a `current_version` with neither state nor
`read_first`, a `null` member, and more). The first text block names the read wherever `read_with`
is given. `as_replay` marks a stored result as a replay. `read_result` reads a result as the
draft's reader rules say: another MAJOR version, or an unknown `outcome`, reads as no shape, and
unknown or malformed members are left out.

Addresses **MWS-RES-1** (report success only for an `applied` write, and `changed: []` for a
no-op), **MWS-RES-2** (a failure is an error and says what remains applied), **MWS-RES-3** and
**RES-4** (identifier, changed fields, new version), **MWS-ATOM-1** (`items` names every item as
applied, not applied or not attempted; never a success when not complete).

### 5. Unknown outcomes

`unknown_outcome(summary, read_with=..., guard=...)` says the outcome is not known, names the read
that settles it, and sets `repeat` to `read_first`, or to `same_key` / `same_version` where the call
carried a key or version that guards a repeat. `guard_write` and `guard_write_async` run a write and
map what it raises: `NotAppliedError` and an unsent request (connection refused, name not resolved,
connect errors of httpx, aiohttp and requests) become `not_applied`; anything else becomes `unknown`,
with `code: "no_answer"` for a timeout or a lost connection and `code: "internal_error"` for any
other error. Only an explicit cause (`raise ... from ...`) is followed: an error raised while
another was being handled is classified by itself. Raw exception messages are not copied into results (a client error can
carry a URL with a token); only the class name is given, or the message of an `OutcomeUnknownError`
you raise yourself.

`kit.write_tool` applies the same mapping to any exception that escapes a handler, with `read_with`
built from `read_tool` and `read_arguments`. Addresses **MWS-RES-2**, and **MWS-SEC-1** in part.

### 6. Annotations

`kit.read_tool(...)` and `kit.write_tool(...)` declare all four hints on every tool.
`annotations.write()` starts from the cautious values (`destructiveHint: true`,
`idempotentHint: false`, `openWorldHint: true`); relax one only where the tool bears it out.
`kit.missing_hints()` lists tools on the server, registered by the kit or not, that leave a hint to
its default. Addresses **MWS-ANN-4**, and makes the claims tested by **MWS-ANN-1** to **ANN-3** a
deliberate choice.

### Wiring into the SDK

`WriteSafety(server)` hooks the SDK's tool manager (`server._tool_manager.call_tool`) on that one
server instance; both SDK lines route every `tools/call` through it. If a future SDK moves it, the
kit refuses to start (`IntegrationError`) rather than run without its checks. Tools registered
directly on the server (`@server.tool()`) are not checked; `kit.unchecked_tools()` lists them.

## mcp-writecheck says X violated: use helper Y

| `mcp-writecheck` says violated | What it means | Use |
|---|---|---|
| MWS-CONC-1 | A write goes through a check the backend offers | `VersionGuard` with `require_version=True`; pass the version to the backend in `write` |
| MWS-CONC-2 | A stale write or delete was applied | `VersionGuard.apply` / `.delete` |
| MWS-CONC-3 | Two concurrent writes both succeeded and one was lost | `VersionGuard` (with a version, one of the two is refused); a field patch in `write` |
| MWS-CONC-4 | A conflict was not an error, or was applied | `VersionGuard`, or `conflict()` |
| MWS-CONC-6 | A conflict carried neither the current state nor a re-read instruction | `conflict()` (`current_state`, `version_argument`, `read_with`) |
| MWS-RES-1 | Success was reported and the state is not in effect | `applied()` only after the write is in effect; `changed: []` for a no-op |
| MWS-RES-2 | A failure looked like success, hid what was applied, or invited a blind retry | `not_applied()`, `partial()`, `unknown_outcome()`, `guard_write()`; `kit.write_tool` for escaped exceptions |
| MWS-RES-3 | A create lost the identifier | `applied(object={"id": ...})`; `items` with each created `id` on a partial create |
| MWS-RES-4 | A receipt lacked the id, the changed fields or the version | `applied(object=..., changed=...)`; `VersionGuard` fills both |
| MWS-ATOM-1 | A multi-item write reported success, or did not say which items were applied | `partial()` / `not_applied(items=...)` with `item()` for every item |
| MWS-RETRY-1 | A create made two objects for one intended write | `Idempotency` and an `idempotency_key` argument |
| MWS-RETRY-2 | A key was applied twice, or a reused key with other arguments was accepted | `Idempotency` with a store shared by every process |
| MWS-IN-1, IN-6 | A wrong type was converted | `WriteSafety(server)` (strict inputs) |
| MWS-IN-2, IN-7 | An unknown argument was dropped | `WriteSafety(server)`; `strict_schema()` |
| MWS-IN-3 | A call outside a declared constraint succeeded | `WriteSafety(server)`; declare the constraint with pydantic `Field(...)` |
| MWS-IN-4 | A refusal was not an error, or did not name the argument | `refuse_arguments()` (through `WriteSafety`) |
| MWS-ANN-4 | A tool left `readOnlyHint` or `destructiveHint` to the default | `kit.read_tool` / `kit.write_tool`; `kit.missing_hints()` |
| MWS-ANN-1, ANN-2, ANN-3, ANN-5 | A hint claims more than the tool does | Correct the hint in `kit.write_tool(...)`: the kit cannot know what your tool does |

No helper covers MWS-UPD-1 and UPD-2 (send only the fields named; address list elements by a
stable id), MWS-TGT-1 to TGT-3 (scope, match-all selectors, create versus overwrite), MWS-RETRY-3
(`input_required`), MWS-CFG-1 to CFG-4 (start-up settings) or MWS-SEC-1 beyond not echoing raw
errors. The example server shows the patterns for UPD-1 and UPD-2.

## Proof: the example server and mcp-writecheck

`examples/notes_server` is a server for notes (one kind of object, with a list field of tags and an
all-or-nothing bulk delete) built only with the kit, over an in-memory store. `writecheck.yaml` is
its `mcp-writecheck` manifest.

```sh
cd examples/notes_server
mcp-writecheck plan -m writecheck.yaml
mcp-writecheck run  -m writecheck.yaml --confirm-target notes-server --plan-hash <hash from plan>
```

The repository's CI runs the tests on SDK 1.x and 2.x with Python 3.10 and 3.13. The
`mcp-writecheck` run on the example is started by hand (`workflow_dispatch`) until the tester is
published with the spec.

A run reports a verdict per requirement and write path. A requirement the example cannot exercise,
or that this preview of `mcp-writecheck` does not test for a tool, is reported `not tested` with the
reason.

## What the kit does not do

- It does not make a server conformant: only the tests decide, per requirement and per write path.
- It cannot know what your backend does. A version check is only as good as the version your `read`
  returns, and an annotation only as true as your tool's behaviour.
- The in-memory idempotency store does not survive a restart and is not shared between processes.
- It does not add transactions: `partial` reports a partial write truthfully; all-or-nothing
  (MWS-ATOM-2) is up to your backend.

## Licence

Apache-2.0. See `LICENSE` and `NOTICE`. Copyright 2026 Stormhaven Enterprises LLC (IsoKron) and
Joshua Bryan.
