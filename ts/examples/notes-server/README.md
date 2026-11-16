# notes-server

A tiny MCP server over an in-memory store, built only with `@mcp-write-safety/kit` and the official TypeScript SDK (1.x, low-level `Server`, stateless Streamable HTTP on 127.0.0.1). It exists to show the kit in use and to be tested with `mcp-writecheck`. It is not a template for production: its store is in memory.

## Tools

| Tool | Kind | Hints (readOnly / destructive / idempotent / openWorld) | Kit helpers |
|---|---|---|---|
| `list_notebooks`, `list_notes`, `get_note` | read | true / false / true / false | `defineTool`, strict inputs |
| `create_notebook` | write | false / false / false / false | a caller-chosen key that is never overwritten; `applied`, `notApplied` |
| `delete_notebook` | write | false / true / true / false | `NotAppliedError`; the description says stale deletes are not detected |
| `create_note` | write | false / false / false / false | `withIdempotency`, `idempotencyKeyProperty`, `applied` |
| `update_note` | write | false / true / true / false | `compareAndSet` (version required), `conflict` |
| `delete_note` | write | false / true / true / false | `compareAndSet` on a delete |
| `add_tag` | write | false / false / true / false | a list edit that only adds |
| `remove_tag` | write | false / true / true / false | a list edit by value |
| `delete_notes` | write | false / true / true / false | a selector is required; all or nothing; `partial` names every item |

Notes live in notebooks (`inbox` is the default). A note has `title`, `body`, `tags` (a list), `status` and a `version` that grows by one with each change.

## Run it

```sh
(cd ../.. && npm ci && npm run build)      # the kit
npm ci && npm run build
node dist/src/main.js                      # {"mcp":"http://127.0.0.1:<port>/mcp"}
npm test                                   # unit tests, and one HTTP round trip
```

## mcp-writecheck

`writecheck.yaml` is the declaration. The tester starts the server itself; the store starts empty apart from `inbox`, so every object in it during a run is the tester's own, and the manifest opts in to the destructive selector forms of MWS-TGT-2.

```sh
mcp-writecheck plan -m writecheck.yaml
mcp-writecheck run  -m writecheck.yaml --confirm-target notes-server --plan-hash <hash from plan>
```

Every write result carries the write-result/0.1 shape (MWS 0.9, Annex B, B-9) in `structuredContent.mws`, and every write tool declares an `outputSchema` built with `outputSchemaFor()`. The manifest format at the tested commit cannot adopt a shape by name and version (B-9's edits to rule 11 and Annex E are not built there), so the manifest declares patterns over the first text block's opening words and the `"outcome"` member of the JSON text block, and reads a replay from the structured member `mws.replayed` (`idempotency.replay_marker`).

### Results of one run

mcp-writecheck at commit f573a24 (0.1.0-dev.0, MWS 0.9, pinned to the spec text with B-9 v2), run `91d3e90f67`, plan `3c1fb14524fdcc78`, 16 November 2026 (UTC), against the build that follows the approved B-9 text with its last delta (integer versions, 14 reserved codes with `not_permitted`, keyed repeats) and the safe conflict default. The plan hash changed from `d5ef93741f7695e4` only because the outputSchema the server lists inlines the schema file, whose code `$comment` now names `not_permitted`. Its 176 records have the same verdicts, record for record, as a run of the build before that change with the same tester (plan `d5ef93741f7695e4`, as in the earlier recorded run `8f30c846fd`). One row per requirement; the write paths for each verdict are in brackets. There is no total: `not tested` and `not applicable` rows make any count meaningless (spec 5.2). No record is `violated`.

| Requirement | Level | Verdicts (write paths) |
|---|---|---|
| MWS-UPD-1 | MUST | held (note:update_note) |
| MWS-UPD-2 | MUST | not tested (no `list_edit` block: `remove_tag` addresses a tag by value) |
| MWS-CONC-1 | MUST | not tested (note:update_note, note:delete_note: needs a control arm through a platform API; the store has none) |
| MWS-CONC-2 | MUST | held (note:update_note, note:delete_note); not tested (notebook:delete_notebook: declared without a version check, and no control arm) |
| MWS-CONC-3 | MUST | not observed (note:update_note, simultaneous pairs, 40 overlapped); not tested (note:update_note, held request: no backend hop to interpose on) |
| MWS-CONC-4 | MUST | held, self-attested "yes" (note:update_note, note:delete_note) |
| MWS-CONC-5 | SHOULD | self-attested "yes" (notebook:delete_notebook); not tested (note:update_note, note:delete_note: neither a control arm nor the declaration shows whether the store can detect the change) |
| MWS-CONC-6 | SHOULD | held (note:update_note, note:delete_note) |
| MWS-TGT-1 | MUST | held (note:create_note, note:delete_notes) |
| MWS-TGT-2 | MUST | held (note:delete_notes) |
| MWS-TGT-3 | MUST | not tested (notebook:create_notebook: the manifest does not declare `key.class` with the words of the tool's description it relies on) |
| MWS-RES-1 | MUST | held (note:update_note, note:delete_note); not tested for the other write tools (not built in the preview) |
| MWS-RES-2 | MUST | held (note:update_note, note:create_note); not tested for the other write tools (not built in the preview); proxy-assisted step not run (no gate) |
| MWS-RES-3 | MUST | held (note:create_note) |
| MWS-RES-4 | SHOULD | held (note:create_note, note:update_note) |
| MWS-ATOM-1 | MUST | held (note:delete_notes) |
| MWS-ATOM-2 | SHOULD | held (note:delete_notes) |
| MWS-RETRY-1 | SHOULD | held (note:create_note) |
| MWS-RETRY-2 | MUST | held (note:create_note, steps (a) to (c)); not observed (note:create_note, simultaneous repeat, 30 overlapped); not tested (proxy-assisted step, restart and crash form: no gate, and a restart empties the in-memory store); not applicable (notebook:create_notebook: no key) |
| MWS-RETRY-3 | MUST | not tested (no tool answers `input_required`; the manifest cannot declare that) |
| MWS-IN-1, IN-6 | MUST, SHOULD | held (note:get_note, note:update_note); not applicable (notebook:list_notebooks: no argument); not tested for the other tools (not built in the preview) |
| MWS-IN-2, IN-7 | MUST, SHOULD | held (notebook:list_notebooks, note:get_note, note:update_note); not tested for the other tools (not built in the preview) |
| MWS-IN-3 | MUST | held (note:get_note, note:update_note); not applicable (notebook:list_notebooks); not tested for the other tools (not built in the preview) |
| MWS-IN-4 | MUST | held, self-attested "yes" (notebook:list_notebooks, note:get_note, note:update_note); not tested for the other tools (not built in the preview) |
| MWS-IN-5 | SHOULD | not observed (note:update_note) |
| MWS-CFG-1 to CFG-4 | MUST, SHOULD | not tested (the server has no read-only mode and no tool filters; the manifest cannot declare their absence) |
| MWS-ANN-1 | MUST | not observed (the three read tools); not applicable (the write tools) |
| MWS-ANN-2, ANN-5 | MUST, SHOULD | not observed (notebook:create_notebook, note:create_note, note:add_tag); not applicable (the tools that declare `destructiveHint: true`) |
| MWS-ANN-3 | MUST | not observed (notebook:delete_notebook, note:update_note, note:delete_note, note:add_tag, note:remove_tag); not applicable (the creates) |
| MWS-ANN-4 | SHOULD | held (every tool) |
| MWS-SEC-1 | MUST | not observed (every tool; the server holds no credential) |

Two notes on the `not tested` rows:

- Several come from the server having no backend hop (`backend.gate`) and no platform API (`control`): the store is inside the server process. The spec names this case (section 12).
- MWS-TGT-3 on `create_notebook`: the tester at this commit asks the declaration to classify a create that names its object (create or upsert) and to quote the words of the tool's description relied on. The manifest does not declare that yet.
