"""Annotations: all four hints, declared explicitly on every tool (MWS-ANN-1 to ANN-4).

The MCP schema's defaults are the cautious values (``readOnlyHint`` false, ``destructiveHint`` true,
``idempotentHint`` false, ``openWorldHint`` true). MWS-ANN-4 asks that ``readOnlyHint`` be declared
on every tool and ``destructiveHint`` on every tool that is not read-only; this module declares all
four, so a client never has to fall back to a default, and starts from the cautious value for each.

Only an explicit claim in the optimistic direction can be wrong, and MWS-ANN-1 to ANN-3 test those
claims: set ``destructive=False`` only for a tool that never deletes and never removes or replaces
data the caller did not name (ANN-2; strictly, ANN-5: one that only adds), ``idempotent=True`` only
for a tool that has no further effect when called again with the same arguments (ANN-3), and
``open_world=False`` only for a tool that reaches nothing outside its own closed domain.
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any

from ._mcp import ToolAnnotations

__all__ = ["read_only", "write", "missing_hints", "HINTS"]

#: The four hints, in the order the MCP schema lists them.
HINTS = ("readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint")


def read_only(*, open_world: bool = True, title: str | None = None) -> ToolAnnotations:
    """Annotations for a tool that does not change state (MWS-ANN-1: it must not).

    ``readOnlyHint: true``; ``destructiveHint: false`` and ``idempotentHint: true``, which the MCP
    schema says are meaningful only for a tool that is not read-only, are set too so that no hint is
    left to a default. ``open_world`` defaults to True, the cautious value.
    """
    kwargs: dict[str, Any] = {
        "readOnlyHint": True,
        "destructiveHint": False,
        "idempotentHint": True,
        "openWorldHint": open_world,
    }
    if title is not None:
        kwargs["title"] = title
    return ToolAnnotations(**kwargs)


def write(
    *,
    destructive: bool = True,
    idempotent: bool = False,
    open_world: bool = True,
    title: str | None = None,
) -> ToolAnnotations:
    """Annotations for a tool that can change state. Every hint starts at the cautious value:
    ``destructiveHint: true``, ``idempotentHint: false``, ``openWorldHint: true``."""
    kwargs: dict[str, Any] = {
        "readOnlyHint": False,
        "destructiveHint": destructive,
        "idempotentHint": idempotent,
        "openWorldHint": open_world,
    }
    if title is not None:
        kwargs["title"] = title
    return ToolAnnotations(**kwargs)


def _hint(annotations: Any, name: str) -> Any:
    if annotations is None:
        return None
    if isinstance(annotations, dict):
        return annotations.get(name)
    snake = {"readOnlyHint": "read_only_hint", "destructiveHint": "destructive_hint",
             "idempotentHint": "idempotent_hint", "openWorldHint": "open_world_hint"}[name]
    for attr in (name, snake):
        if hasattr(annotations, attr):
            return getattr(annotations, attr)
    return None


def missing_hints(tools: Iterable[Any]) -> dict[str, list[str]]:
    """For each tool that leaves a hint to its default, the hints it leaves out.

    ``tools`` are tool definitions as ``tools/list`` gives them (objects with ``name`` and
    ``annotations``, or dicts). An empty dict means every tool declares all four hints. MWS-ANN-4
    itself asks only for ``readOnlyHint`` everywhere and ``destructiveHint`` on tools that are not
    read-only; this check asks for all four.
    """
    out: dict[str, list[str]] = {}
    for t in tools:
        name = t["name"] if isinstance(t, dict) else t.name
        ann = t.get("annotations") if isinstance(t, dict) else getattr(t, "annotations", None)
        missing = [h for h in HINTS if _hint(ann, h) is None]
        if missing:
            out[name] = missing
    return out
