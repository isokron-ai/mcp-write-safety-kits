"""mws_kit: helpers for MCP write tools that meet the hard parts of the MCP Write-Safety
Requirements (MWS 0.9) by default.

Using the kit helps a server meet MWS; it does not make a server conformant. Only the tests decide
(for example ``mcp-writecheck``), per requirement and per write path.

Parts:

- :mod:`mws_kit.result`: the write-result shape 0.1 (MWS 0.9, Annex B, B-9) and its builders.
- :mod:`mws_kit.schema`: its JSON Schema, and the ``outputSchema`` of a tool that carries it.
- :mod:`mws_kit.version`: compare-and-set around your read and write (MWS-CONC-2, CONC-4, CONC-6).
- :mod:`mws_kit.idempotency`: idempotency keys kept by the server (MWS-RETRY-1, RETRY-2).
- :mod:`mws_kit.strict`: strict argument checking (MWS-IN-1, IN-2, IN-3, IN-4, IN-6, IN-7).
- :mod:`mws_kit.unknown`: unknown outcomes (MWS-RES-2).
- :mod:`mws_kit.annotations`: all four hints, explicit (MWS-ANN-1 to ANN-4).
- :mod:`mws_kit.server`: :class:`WriteSafety`, which wires these into FastMCP / MCPServer.
"""

from .annotations import missing_hints, read_only, write
from .idempotency import AsyncIdempotencyStore, Idempotency, IdempotencyStore, InMemoryIdempotencyStore, KeyRecord, fingerprint
from .result import (
    CODES,
    REPLAY_NOTE,
    SHAPE,
    ShapeError,
    accepted,
    applied,
    as_replay,
    assert_shape,
    conflict,
    conflict_info,
    item,
    not_applied,
    opening_line,
    partial,
    pointer,
    q,
    read_answer,
    read_result,
    read_with,
    render_text,
    restate,
    to_tool_result,
)
from .schema import WRITE_RESULT_SCHEMA, output_schema
from .server import IntegrationError, WriteSafety
from .strict import ArgumentIssue, UnsupportedSchema, check_arguments, refuse_arguments, strict_schema
from .unknown import (
    NotAppliedError,
    OutcomeUnknownError,
    RepeatGuard,
    classify_error,
    unknown_code,
    guard_write,
    guard_write_async,
    unknown_outcome,
    refusal_result,
)
from .version import Snapshot, VersionConflict, VersionGuard, changed_fields

__version__ = "0.1.0"

__all__ = [
    "__version__",
    # result shape (write-result/0.1)
    "SHAPE", "CODES", "REPLAY_NOTE", "WRITE_RESULT_SCHEMA", "ShapeError",
    "applied", "accepted", "not_applied", "partial", "conflict", "conflict_info", "item", "read_with", "pointer",
    "to_tool_result", "render_text", "opening_line", "restate", "assert_shape", "read_result", "read_answer",
    "as_replay", "q",
    "output_schema",
    # unknown outcomes
    "unknown_outcome", "refusal_result", "guard_write", "guard_write_async", "classify_error", "unknown_code", "RepeatGuard",
    "NotAppliedError", "OutcomeUnknownError",
    # version check
    "VersionGuard", "Snapshot", "VersionConflict", "changed_fields",
    # retry keys
    "Idempotency", "IdempotencyStore", "AsyncIdempotencyStore", "InMemoryIdempotencyStore", "KeyRecord", "fingerprint",
    # strict inputs
    "check_arguments", "strict_schema", "refuse_arguments", "ArgumentIssue", "UnsupportedSchema",
    # annotations
    "read_only", "write", "missing_hints",
    # integration
    "WriteSafety", "IntegrationError",
]
