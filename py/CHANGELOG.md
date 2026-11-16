# Changelog

## 0.1.0 (unreleased)

First version, for the MWS 0.9 comment window.

- Results in the write-result shape 0.1 (MWS 0.9, Annex B, B-9, as approved): `structuredContent.mws`,
  a statement generated from the shape and the serialized JSON as text, `isError` by outcome, the 14
  reserved codes, `argument_errors`, per-item conflicts, `object.parent`, keyed repeats, and an
  `outputSchema` for every write tool. The shape's JSON Schema ships as
  `mws_kit/write-result-0.1.schema.json` (CC BY 4.0), the same file as the specification's.
- `VersionGuard`: compare-and-set with conflict results that carry the current version, and the
  current state only for the fields `state_fields` allow-lists (none by default).
- `Idempotency` and `InMemoryIdempotencyStore`: idempotency keys, safe for threads and asyncio.
- Strict inputs: arguments checked against the tool's schema before the SDK converts them.
- `unknown_outcome`, `guard_write`: truthful results for a lost answer.
- `WriteSafety`: registers tools on FastMCP (SDK 1.x) or MCPServer (SDK 2.x) with all four
  annotation hints, strict inputs and an output schema; hooks in through the public middleware on
  2.x and the tool manager on 1.x; checks every write result against the shape and fails closed.
- `examples/notes_server` with its `mcp-writecheck` manifest.
