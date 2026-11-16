<p>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/mws-mark-dark.svg">
    <img src="assets/mws-mark.svg" alt="MCP Write-Safety Requirements mark" width="72" height="72">
  </picture>
</p>

<sub>The MWS mark is not covered by this repository's licence; its use is described in the specification's <a href="https://github.com/isokron-ai/mcp-write-safety/blob/main/TRADEMARKS.md">TRADEMARKS.md</a>.</sub>

# MCP Write-Safety kits

Helper libraries for the write tools of an MCP server, in TypeScript and Python. They cover the parts of the MCP Write-Safety Requirements that are easy to get wrong by hand.

## What MWS is

The MCP Write-Safety Requirements (MWS) are a specification for MCP servers whose tools change state: create, update and delete. They state what a server does so that a caller never loses another writer's change, never applies a write twice, and never reports a write that did not happen. They cover version checks, idempotency keys, strict input validation, truthful results, unknown outcomes and tool annotations, and they come with a tester that checks a server against each requirement, per write path.

Version 0.9 is the version these kits follow. The spec is published at launch.

## The kits

| Folder | Package | Language | Status |
|---|---|---|---|
| [`ts/`](ts/) | `@mcp-write-safety/kit` | TypeScript, Node 20 or later | 0.1.0, not published |
| [`py/`](py/) | `mcp-write-safety-kit` (import `mws_kit`) | Python 3.10 or later, MCP Python SDK 1.x and 2.x | 0.1.0 on [PyPI](https://pypi.org/project/mcp-write-safety-kit/) |

Both kits give the same helpers:

- **Version check**: compare-and-set around your own read and write. A stale write is refused with a conflict that carries the current state and version.
- **Retry keys**: idempotency keys kept by the server, so a repeated call is applied at most once.
- **Strict inputs**: arguments are checked against the tool's own JSON Schema. Nothing is converted, and unknown arguments are refused.
- **Result builders**: every write result says what the write did, in structured form and in text.
- **Unknown outcomes**: a lost answer is reported as unknown, with the read that settles it, and never as a failure.
- **Annotations**: all four hints are set explicitly, starting from the cautious values.

Both kits emit the same result shape, `write-result/0.1`, described in Annex B-9 of MWS 0.9. It goes in `structuredContent.mws` beside the tool's own output, and every result also says the same thing in text. The two kits ship the same JSON Schema for the shape, byte for byte: [`ts/schema/write-result-0.1.schema.json`](ts/schema/write-result-0.1.schema.json) and [`py/src/mws_kit/write-result-0.1.schema.json`](py/src/mws_kit/write-result-0.1.schema.json). The shape is a draft and may change before MWS 1.0.

Using a kit helps a server meet MWS. It does not make a server conformant. Only the tests decide, per requirement and per write path.

Each kit has an example server built only with the kit: [`ts/examples/notes-server`](ts/examples/notes-server) and [`py/examples/notes_server`](py/examples/notes_server). Each has a manifest for the `mcp-writecheck` tester and the results of a run.

## Develop

```sh
# TypeScript
cd ts && npm ci && npm test
cd examples/notes-server && npm ci && npm test

# Python
cd py && python -m pip install -e ".[test]" && python -m pytest
```

CI runs both kits' tests on every push and pull request. The `mws` workflow, which runs the tester against both example servers, is started by hand.

## Licence

The code is under the Apache License 2.0 ([`LICENSE`](LICENSE), [`NOTICE`](NOTICE)). The schema file of the result shape is under CC BY 4.0; a note beside each copy says so.

Made by [IsoKron](https://isokron.ai/?utm_source=github&utm_medium=readme&utm_campaign=mcp-write-safety-kits).
