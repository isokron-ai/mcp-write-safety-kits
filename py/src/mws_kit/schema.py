"""The JSON Schema of the write-result shape 0.1, and the ``outputSchema`` of a write tool that
carries it (MWS 0.9 Annex B, B-9, "Output schema").

Where a tool declares an ``outputSchema``, the MCP specification requires its structured results to
conform, so the schema declares the member ``mws``. B-9 advises including the shape's schema
in the tool's own (here under ``$defs``) rather than leaving it for a client to fetch, and requiring
``mws`` always but the tool's own output members only where ``outcome`` is ``applied`` (JSON Schema
2020-12 ``if``/``then``), which is valid whether or not a client applies the schema to an error result.
"""

from __future__ import annotations

import copy
import json
from collections.abc import Mapping
from importlib import resources
from typing import Any

__all__ = ["WRITE_RESULT_SCHEMA", "output_schema", "schema_file_text"]

_FILE = "write-result-0.1.schema.json"


def schema_file_text() -> str:
    """The shipped schema file (``mws_kit/write-result-0.1.schema.json``), as text."""
    return resources.files("mws_kit").joinpath(_FILE).read_text(encoding="utf-8")


#: The schema of the ``mws`` member (the shape itself), as shipped in the package.
WRITE_RESULT_SCHEMA: dict[str, Any] = json.loads(schema_file_text())


def _rebase(node: Any) -> Any:
    """Points the shape's own ``$ref``s (``#/$defs/...``) at their place once the shape sits under
    ``$defs.write_result`` of the tool's schema."""
    if isinstance(node, dict):
        return {
            k: ("#/$defs/write_result/$defs/" + v[len("#/$defs/"):] if k == "$ref" and isinstance(v, str) and v.startswith("#/$defs/") else _rebase(v))
            for k, v in node.items()
        }
    if isinstance(node, list):
        return [_rebase(x) for x in node]
    return node


def output_schema(own: Mapping[str, Any] | None = None) -> dict[str, Any]:
    """The ``outputSchema`` for a write tool whose results carry the shape.

    ``own`` is the schema of the tool's own output (an object schema), or None for a tool that
    returns only the shape. Its ``required`` members are required only where ``mws.outcome`` is
    ``"applied"``; ``mws`` is required always. The shape's schema is inlined under
    ``$defs.write_result``, and ``additionalProperties`` is never set on ``mws``.

    Where the SDK generates the schema from a pydantic return type instead, that type has to mark
    its own members ``Optional`` (with a default): otherwise the schema requires them on error
    results too, which carry only ``mws``.
    """
    own = copy.deepcopy(dict(own)) if own else {}
    if own and own.get("type", "object") != "object":
        raise ValueError("a tool whose structured output is not a JSON object cannot carry the shape beside it")
    props = dict(own.get("properties") or {})
    if "mws" in props:
        raise ValueError("the tool's own output may not use the member name mws")
    shape = _rebase({k: v for k, v in WRITE_RESULT_SCHEMA.items() if k not in ("$schema", "$id")})
    out: dict[str, Any] = {
        "type": "object",
        "properties": {"mws": {"$ref": "#/$defs/write_result"}, **props},
        "required": ["mws"],
    }
    for k in ("additionalProperties", "description", "title"):
        if k in own:
            out[k] = own[k]
    required = list(own.get("required") or [])
    if required:
        out["if"] = {
            "properties": {"mws": {"properties": {"outcome": {"const": "applied"}}, "required": ["outcome"]}},
            "required": ["mws"],
        }
        out["then"] = {"required": required}
    defs = dict(own.get("$defs") or {})
    if "write_result" in defs:
        raise ValueError("the tool's own $defs may not use the name write_result")
    defs["write_result"] = shape
    out["$defs"] = defs
    return out
