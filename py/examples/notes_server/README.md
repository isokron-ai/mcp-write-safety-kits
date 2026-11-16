# notes_server

A small MCP server for notes, built only with `mcp-write-safety-kit`, over an in-memory store. It
is the kit's proof: `writecheck.yaml` is its `mcp-writecheck` manifest.

| Tool | Hints (readOnly, destructive, idempotent, openWorld) | What it shows |
|---|---|---|
| `list_notes`, `get_note` | true, false, true, false | reads; every note carries its version |
| `create_note` | false, false, false, false | an optional `idempotency_key` (`Idempotency`), a receipt with the id and version |
| `update_note` | false, true, true, false | a field patch that needs `expected_version` (`VersionGuard`); a conflict carries the current state |
| `delete_note` | false, true, true, false | a delete that needs `expected_version` |
| `add_tag`, `remove_tag` | false, false/true, true, false | a list field whose elements are addressed by value, so an edit cannot land on the wrong element |
| `delete_notes` | false, true, true, false | an all-or-nothing bulk delete whose result names every item; versions required unless `force` is set |

```sh
pip install -e ../..                 # the kit and the MCP Python SDK
python server.py                     # streamable HTTP; first stdout line: {"mcp": "http://127.0.0.1:<port>/mcp"}
python server.py --stdio             # stdio
mcp-writecheck plan -m writecheck.yaml
mcp-writecheck run  -m writecheck.yaml --confirm-target notes-server --plan-hash <hash>
```

The store is empty at every start and nothing else writes to it, so every object in it is
disposable. A restart loses the notes and the idempotency keys alike.
