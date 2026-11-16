"""The write-result shape, version 0.1 (MWS 0.9 draft Annex B-9), and the builders that produce it.

A write tool's result carries the shape as the member ``mws`` of ``structuredContent``; the tool's
own output, if any, sits beside it. The content has two text blocks: a plain statement of the outcome
in the spec's words (with the read to make, where there is one), then the serialized JSON of
``structuredContent``. Both say the same thing.

::

    {"mws": {"shape": "write-result/0.1",
             "outcome": "applied" | "not_applied" | "partial" | "unknown" | "accepted",
             "repeat": "no" | "yes" | "same_key" | "same_version" | "read_first",
             "operation": "create" | "update" | "delete" | <command>,
             "object": {"type", "id", "version", "scope"},          # strings
             "changed": ["/title", ...],                            # JSON Pointers; [] = nothing changed
             "replayed": true,
             "items": [{"index", "step", "id", "version", "outcome", "code", "message"}],
             "applied_count": 3,
             "code": "conflict" | "locked" | "version_required" | "invalid_argument" | "no_answer" | "not_sent" | ...,
             "message": "...",
             "argument": "/title",                                  # JSON Pointer into the arguments
             "conflict": {"current_version", "version_source", "current_state", "omitted", "held_by"},
             "read_with": {"tool": "get_note", "arguments": {"id": "n-3"}},
             "version_argument": "expected_version"}}

The shape is a draft (``0.x``): a later 0.y may change it. The kit writes ``isError: true`` for
``not_applied``, ``partial`` and ``unknown``, and leaves it out for ``applied`` and ``accepted``, as
the draft's outcome table says the requirements expect.
"""

from __future__ import annotations

import json
import re
from collections.abc import Iterable, Mapping, Sequence
from typing import Any, Literal, TypedDict

from ._mcp import CallToolResult, TextContent, structured_of

__all__ = [
    "SHAPE",
    "SHAPE_NAME",
    "SHAPE_VERSION",
    "Outcome",
    "Repeat",
    "ItemOutcome",
    "ReadWith",
    "CODES",
    "ShapeError",
    "pointer",
    "q",
    "read_with",
    "item",
    "render_text",
    "assert_shape",
    "to_tool_result",
    "applied",
    "accepted",
    "not_applied",
    "partial",
    "conflict",
    "read_result",
    "as_replay",
    "read_answer",
    "REPLAY_NOTE",
]

SHAPE_NAME = "write-result"
SHAPE_VERSION = "0.1"
#: The value of ``mws.shape``.
SHAPE = f"{SHAPE_NAME}/{SHAPE_VERSION}"

Outcome = Literal["applied", "not_applied", "partial", "unknown", "accepted"]
Repeat = Literal["no", "yes", "same_key", "same_version", "read_first"]
ItemOutcome = Literal["applied", "not_applied", "not_attempted", "unknown"]

#: The codes whose meaning the draft fixes. A server may define others (lowercase, digits, underscores).
CODES: dict[str, str] = {
    "conflict": "refused because the object changed since the state the call carried",
    "locked": "refused because of a lock or another concurrency control that is not a version",
    "version_required": "refused because the call did not carry a version that the tool requires",
    "invalid_argument": "refused because an argument is not valid",
    "no_answer": "a request that changes state was sent, and no answer from the backend was received",
    "not_sent": "the call failed before any request that changes state was sent",
}

_OUTCOMES = ("applied", "not_applied", "partial", "unknown", "accepted")
_REPEATS = ("no", "yes", "same_key", "same_version", "read_first")
_ITEM_OUTCOMES = ("applied", "not_applied", "not_attempted", "unknown")
_IS_ERROR = {"applied": False, "accepted": False, "not_applied": True, "partial": True, "unknown": True}
_CODE_RE = re.compile(r"^[a-z0-9_]+$")

#: The sentence added to the text of a replayed result (``mws.replayed: true``).
REPLAY_NOTE = (
    "This call repeats an earlier call with the same idempotency key: nothing was applied again, "
    "and this is the outcome of the first call."
)


class ReadWith(TypedDict):
    tool: str
    arguments: dict[str, Any]


class ShapeError(TypeError):
    """A result breaks a rule of the shape."""


def q(value: Any) -> str:
    """A value quoted for a sentence, as compact JSON, so it can be read only one way."""
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)


def pointer(*path: str | int) -> str:
    """A JSON Pointer (RFC 6901) from path segments: ``pointer("details", "severity")`` is
    ``"/details/severity"``; ``pointer()`` is ``""``, the whole document."""
    return "".join("/" + str(p).replace("~", "~0").replace("/", "~1") for p in path)


def read_with(tool: str, **arguments: Any) -> ReadWith:
    """The ``read_with`` member: a read that shows the current state of the object."""
    return {"tool": tool, "arguments": dict(arguments)}


def item(
    index: int,
    outcome: ItemOutcome,
    *,
    id: Any = None,  # noqa: A002 - the shape's member name
    version: Any = None,
    step: str | None = None,
    code: str | None = None,
    message: str | None = None,
) -> dict[str, Any]:
    """One entry of ``items``: an item or step of the call, by its position (from 0)."""
    out: dict[str, Any] = {"index": index}
    if step is not None:
        out["step"] = step
    if id is not None:
        out["id"] = str(id)
    if version is not None:
        out["version"] = str(version)
    out["outcome"] = outcome
    if code is not None:
        out["code"] = code
    if message is not None:
        out["message"] = message
    return out


def _object(obj: Mapping[str, Any] | None) -> dict[str, str] | None:
    if obj is None:
        return None
    # The draft gives every member of `object` as a string.
    return {k: str(v) for k, v in obj.items() if k in ("type", "id", "version", "scope") and v is not None}


# ------------------------------------------------------------------------------------------------
# Text


def _sentence(s: str) -> str:
    t = s.strip()
    return t if not t or t[-1] in ".!?" else f"{t}."


def _read_sentence(rw: Mapping[str, Any]) -> str:
    args = rw.get("arguments") or {}
    return f"read with {q(rw['tool'])}" + (f" and the arguments {q(args)}" if args else "")


def _repeat_sentence(m: Mapping[str, Any], key: tuple[str, Any] | None, version: tuple[str, Any] | None) -> str:
    rep = m.get("repeat")
    rw = m.get("read_with")
    if rep == "no":
        if m.get("code") in ("invalid_argument", "version_required"):
            return "Do not send the same call again: correct it as the reason says first"
        return "Do not send the same call again"
    if rep == "yes":
        return "The same call may be sent again unchanged; it cannot apply the write more than once"
    if rep == "same_key":
        what = f"the same {key[0]} {q(key[1])}" if key else "the idempotency key this call carried"
        return f"Send the same call again only with {what}; it will not apply the write twice"
    if rep == "same_version":
        what = f"the same {version[0]} {q(version[1])}" if version else "the version this call carried"
        return f"Send the same call again only with {what}; if the first call was applied, the repeat is refused"
    if rep == "read_first":
        how = _read_sentence(rw) if rw else "read the object"
        return f"Before writing again, {how} and build the write from what it shows"
    return ""


_OPENING = {
    "applied": "Applied",
    "accepted": "Accepted",
    "not_applied": "Not applied",
    "partial": "Partly applied",
    "unknown": "Outcome unknown",
}
_ITEM_WORD = {"applied": "applied", "not_applied": "not applied", "not_attempted": "not attempted", "unknown": "outcome unknown"}


def render_text(
    structured: Mapping[str, Any],
    summary: str,
    notes: Iterable[str] = (),
    *,
    key: tuple[str, Any] | None = None,
    version: tuple[str, Any] | None = None,
) -> str:
    """The first text block: the outcome in the spec's words, then the facts a caller acts on.

    It opens with words fixed by ``mws.outcome`` ("Applied:", "Not applied:", "Partly applied:",
    "Outcome unknown:", "Accepted:"), so a tester's declared pattern can read it (spec 7.3, rule 11).
    ``summary`` is one sentence without a final period, with values quoted (use :func:`q`).
    """
    m = structured["mws"]
    outcome = m["outcome"]
    lines = [_sentence(f"{_OPENING[outcome]}: {summary}")]
    if outcome == "not_applied":
        lines[0] += " Nothing was changed."
    elif outcome == "unknown":
        lines[0] += " It is not known whether the change was applied."
    elif outcome == "accepted":
        lines[0] += " The backend has not yet reported the result."
    if m.get("replayed"):
        lines.append(REPLAY_NOTE)
    if m.get("message") and m["message"] not in lines[0]:
        lines.append(_sentence(f"Reason ({m['code']}): {m['message']}" if m.get("code") else f"Reason: {m['message']}"))
    if "object" in m and outcome in ("applied", "accepted"):
        o = m["object"]
        lines.append(
            "Object: " + ", ".join(f"{k} {q(o[k])}" for k in ("type", "id", "version", "scope") if k in o) + "."
        )
    if "changed" in m and outcome in ("applied", "accepted"):
        ch = m["changed"]
        lines.append(f"Changed: {', '.join(q(c) for c in ch)}." if ch else "Nothing changed: the values were already as asked.")
    for it in m.get("items") or []:
        name = f"Item {it['index']}" + (f" ({q(it['id'])})" if "id" in it else "") + (f", step {q(it['step'])}" if "step" in it else "")
        why = f": {it['message']}" if "message" in it else ""
        lines.append(_sentence(f"{name}: {_ITEM_WORD[it['outcome']]}{why}"))
    if "applied_count" in m:
        lines.append(f"Applied to {m['applied_count']} objects.")
    c = m.get("conflict")
    if c:
        if "current_version" in c:
            arg = m.get("version_argument")
            lines.append(f"Current version: {q(c['current_version'])}" + (f" (send it as {arg})." if arg else "."))
        if "current_state" in c:
            lines.append(f"Current state (JSON): {q(c['current_state'])}")
        if c.get("omitted"):
            lines.append(f"Left out of the current state: {', '.join(q(o) for o in c['omitted'])}.")
        if "held_by" in c:
            lines.append(f"Held by: {q(c['held_by'])}.")
        if m.get("code") == "conflict":
            lines.append(
                "Apply your change to the current state, not to the state you read. Do not resend your earlier "
                "values with the new version: that would overwrite the other writer's change."
            )
    for n in notes:
        lines.append(_sentence(n))
    rs = _repeat_sentence(m, key, version)
    if rs:
        lines.append(_sentence(rs))
    if m.get("read_with") and m.get("repeat") != "read_first" and outcome != "applied":
        lines.append(_sentence(f"To see the current state, {_read_sentence(m['read_with'])}"))
    return "\n".join(lines)


# ------------------------------------------------------------------------------------------------
# Rules


def assert_shape(structured: Mapping[str, Any]) -> None:
    """Checks a ``structuredContent`` against the rules of the shape that the kit can check.
    Raises :class:`ShapeError` naming the first one broken."""

    def fail(msg: str) -> None:
        raise ShapeError(f"{SHAPE}: {msg}")

    m = structured.get("mws")
    if not isinstance(m, Mapping):
        fail("structuredContent.mws must be an object")
    assert isinstance(m, Mapping)
    if m.get("shape") != SHAPE:
        fail(f"mws.shape must be {q(SHAPE)}")
    o = m.get("outcome")
    if o not in _OUTCOMES:
        fail(f"mws.outcome {q(o)} is not one of {', '.join(_OUTCOMES)}")
    for k, v in m.items():
        if v is None:
            fail(f"mws.{k} is null; a member that does not apply is left out")
    rep = m.get("repeat")
    if rep is not None and rep not in _REPEATS:
        fail(f"mws.repeat {q(rep)} is not one of {', '.join(_REPEATS)}")
    if rep == "yes" and o in ("unknown", "partial", "accepted"):
        fail(f'repeat "yes" does not go with outcome {q(o)} (MWS-RES-2: kind retry-invited)')
    if "code" in m and not (isinstance(m["code"], str) and _CODE_RE.match(m["code"])):
        fail("mws.code must be lowercase letters, digits and underscores")
    obj = m.get("object")
    if obj is not None:
        if any(not isinstance(v, str) for v in obj.values()):
            fail("every member of mws.object is a string")
        if o == "not_applied" and "version" in obj:
            fail("on not_applied, object.version is left out (the current version goes in conflict)")
    for c in m.get("changed", []):
        if not isinstance(c, str) or not (c == "" or c.startswith("/")):
            fail(f"mws.changed holds JSON Pointers; {q(c)} is not one")
    if "argument" in m and not (isinstance(m["argument"], str) and (m["argument"] == "" or m["argument"].startswith("/"))):
        fail("mws.argument is a JSON Pointer into the arguments")
    for it in m.get("items", []):
        if not isinstance(it.get("index"), int) or it.get("outcome") not in _ITEM_OUTCOMES:
            fail("each item has an integer index and an outcome of applied, not_applied, not_attempted or unknown")
    if o == "partial":
        outs = [it.get("outcome") for it in m.get("items", [])]
        if "unknown" in outs:
            fail("an item with an open outcome makes the whole outcome unknown, not partial")
        if not ("applied" in outs or m.get("applied_count")) or not any(x in ("not_applied", "not_attempted") for x in outs):
            fail("partial needs at least one item applied and one not")
    c = m.get("conflict")
    if c is not None:
        if m.get("code") not in ("conflict", "locked"):
            fail('mws.conflict is present only where code is "conflict" or "locked"')
        if "current_version" in c and "current_state" not in c and rep != "read_first":
            fail('a current_version comes with current_state or with repeat "read_first" (MWS-CONC-6 guidance)')
        if c.get("version_source") not in (None, "backend", "server"):
            fail('conflict.version_source is "backend" or "server"')
    rw = m.get("read_with")
    if rw is not None and not (isinstance(rw.get("tool"), str) and isinstance(rw.get("arguments", {}), Mapping)):
        fail("mws.read_with is {tool, arguments}")
    if "replayed" in m and m["replayed"] is not True:
        fail("mws.replayed is true or left out")


def to_tool_result(
    mws: Mapping[str, Any],
    summary: str,
    notes: Iterable[str] = (),
    *,
    data: Mapping[str, Any] | None = None,
    key: tuple[str, Any] | None = None,
    version: tuple[str, Any] | None = None,
) -> CallToolResult:
    """Builds the tool result: ``structuredContent = {**data, "mws": mws}``, a statement in the first
    text block, the serialized JSON in the second, and ``isError`` as the outcome implies.

    ``data`` is the tool's own output. Give it on ``applied`` (the draft's schema advice requires the
    tool's own members only there). ``key`` and ``version`` (argument name, value) let the text
    name the guard behind ``repeat: "same_key"`` or ``"same_version"``.
    """
    m = {"shape": SHAPE, **{k: v for k, v in mws.items() if v is not None and k != "shape"}}
    if data is not None and "mws" in data:
        raise ShapeError("the tool's own output may not use the member name mws")
    structured = {**(dict(data) if data else {}), "mws": m}
    assert_shape(structured)
    kwargs: dict[str, Any] = {
        "content": [
            TextContent(type="text", text=render_text(structured, summary, notes, key=key, version=version)),
            TextContent(type="text", text=q(structured)),
        ],
        "structuredContent": structured,
    }
    if _IS_ERROR[m["outcome"]]:
        kwargs["isError"] = True
    return CallToolResult(**kwargs)


# ------------------------------------------------------------------------------------------------
# Builders


def applied(
    summary: str,
    *,
    object: Mapping[str, Any] | None = None,  # noqa: A002 - the shape's member name
    changed: Sequence[str] | None = None,
    operation: str | None = None,
    repeat: Repeat = "no",
    items: Sequence[Mapping[str, Any]] | None = None,
    applied_count: int | None = None,
    read_with: ReadWith | None = None,
    data: Mapping[str, Any] | None = None,
    key: tuple[str, Any] | None = None,
    notes: Iterable[str] = (),
) -> CallToolResult:
    """A receipt: the state asked for is in effect (MWS-RES-1, RES-3, RES-4).

    Give ``object`` with its version after the write, and ``changed`` as JSON Pointers into the
    object as the read tool returns it (:func:`pointer`); ``[]`` says nothing changed, and leaving
    it out says nothing. ``repeat`` defaults to ``"no"``.
    """
    return to_tool_result(
        {
            "outcome": "applied",
            "repeat": repeat,
            "operation": operation,
            "object": _object(object),
            "changed": list(changed) if changed is not None else None,
            "items": [dict(i) for i in items] if items is not None else None,
            "applied_count": applied_count,
            "read_with": read_with,
        },
        summary,
        notes,
        data=data,
        key=key,
    )


def accepted(
    summary: str,
    *,
    object: Mapping[str, Any] | None = None,  # noqa: A002
    operation: str | None = None,
    read_with: ReadWith | None = None,
    data: Mapping[str, Any] | None = None,
    notes: Iterable[str] = (),
) -> CallToolResult:
    """The backend accepted the request for later processing (NF-19). Only for an operation the
    backend completes asynchronously; a tester reads it as success for any other."""
    return to_tool_result(
        {"outcome": "accepted", "repeat": "no", "operation": operation, "object": _object(object), "read_with": read_with},
        summary,
        notes,
        data=data,
    )


def not_applied(
    summary: str,
    *,
    code: str | None = None,
    message: str | None = None,
    argument: str | None = None,
    object: Mapping[str, Any] | None = None,  # noqa: A002
    operation: str | None = None,
    repeat: Repeat | None = None,
    items: Sequence[Mapping[str, Any]] | None = None,
    read_with: ReadWith | None = None,
    notes: Iterable[str] = (),
) -> CallToolResult:
    """A refusal: no change made by the call is in effect (``isError: true``; MWS-RES-2, CONC-4,
    IN-4).

    ``repeat`` defaults to ``"yes"`` for ``code="not_sent"`` (nothing was sent) and ``"no"``
    otherwise: a refusal that a repeat would meet again.
    """
    if repeat is None:
        repeat = "yes" if code == "not_sent" else "no"
    obj = _object(object)
    if obj is not None:
        obj.pop("version", None)
    return to_tool_result(
        {
            "outcome": "not_applied",
            "repeat": repeat,
            "operation": operation,
            "object": obj,
            "items": [dict(i) for i in items] if items is not None else None,
            "code": code,
            "message": message,
            "argument": argument,
            "read_with": read_with,
        },
        summary,
        notes,
    )


def partial(
    summary: str,
    *,
    items: Sequence[Mapping[str, Any]],
    applied_count: int | None = None,
    code: str | None = None,
    message: str | None = None,
    operation: str | None = None,
    repeat: Repeat = "read_first",
    read_with: ReadWith | None = None,
    key: tuple[str, Any] | None = None,
    notes: Iterable[str] = (),
) -> CallToolResult:
    """A write of several items or steps, each settled or not attempted, some applied and some not
    (MWS-ATOM-1, RES-2). Never a success (``isError: true``). ``items`` names each one.

    If no item was applied, this is :func:`not_applied` with the items. If any item's outcome is
    open, use :func:`mws_kit.unknown_outcome` with the items.
    """
    outs = [i["outcome"] for i in items]
    if "applied" not in outs and not applied_count:
        return not_applied(summary, code=code, message=message, operation=operation, items=items, read_with=read_with, notes=notes)
    return to_tool_result(
        {
            "outcome": "partial",
            "repeat": repeat,
            "operation": operation,
            "items": [dict(i) for i in items],
            "applied_count": applied_count,
            "code": code,
            "message": message,
            "read_with": read_with,
        },
        summary,
        notes,
        key=key,
    )


def conflict(
    id: Any,  # noqa: A002
    *,
    current_state: Mapping[str, Any] | None,
    read_tool: str,
    current_version: Any = None,
    version_source: Literal["backend", "server"] | None = None,
    omitted: Sequence[str] = (),
    held_by: str | None = None,
    code: Literal["conflict", "locked"] = "conflict",
    noun: str = "object",
    object_type: str | None = None,
    id_argument: str = "id",
    version_argument: str | None = "expected_version",
    operation: str | None = None,
    message: str | None = None,
    notes: Iterable[str] = (),
) -> CallToolResult:
    """A write refused because the object changed since the state the call carried (``code``
    ``"conflict"``; MWS-CONC-2, CONC-4, CONC-6) or because of a lock (``"locked"``; CONC-1).

    Carries the current state as JSON (only fields the caller may read through the read tool; list
    whatever is left out in ``omitted``, as JSON Pointers) and the current version on its own, as a
    string, never ``null``: leave ``current_version`` as None where the backend has none. ``repeat`` is
    ``"read_first"``: the state in the result may stand in for the read where nothing is omitted.
    """
    c: dict[str, Any] = {}
    if current_version is not None:
        c["current_version"] = str(current_version)  # a string, as every version in the shape
        if version_source is not None:
            c["version_source"] = version_source
    if current_state is not None:
        c["current_state"] = dict(current_state)
    if omitted:
        c["omitted"] = list(omitted)
    if held_by is not None:
        c["held_by"] = held_by
    default = f"{noun} {q(id)} changed since the version you read" if code == "conflict" else f"{noun} {q(id)} is locked"
    return to_tool_result(
        {
            "outcome": "not_applied",
            "repeat": "read_first",
            "operation": operation,
            "object": _object({"type": object_type, "id": id}),
            "code": code,
            "message": message or default,
            "conflict": c,
            "read_with": {"tool": read_tool, "arguments": {id_argument: id}},
            "version_argument": version_argument if current_version is not None else None,
        },
        f"{default}, so the write was refused",
        notes,
    )


def read_result(result: CallToolResult) -> dict[str, Any] | None:
    """The ``mws`` member of a result, where it carries this shape's MAJOR version; else None.
    (A result of another MAJOR version is read as if it carried no shape.)"""
    s = structured_of(result)
    m = s.get("mws") if isinstance(s, dict) else None
    if isinstance(m, dict) and isinstance(m.get("shape"), str) and m["shape"].startswith(f"{SHAPE_NAME}/"):
        major = m["shape"].split("/", 1)[1].split(".", 1)[0]
        if major == SHAPE_VERSION.split(".", 1)[0]:
            return m
    return None


def as_replay(result: CallToolResult) -> CallToolResult:
    """The first call's result, answered to a repeat with the same idempotency key: the same
    shape with ``replayed: true``, and :data:`REPLAY_NOTE` in the first text block."""
    s = structured_of(result) or {}
    m = s.get("mws") if isinstance(s, dict) else None
    texts = [getattr(b, "text", "") for b in result.content if getattr(b, "type", None) == "text"]
    first = texts[0] if texts else ""
    lines = first.split("\n")
    lines.insert(1, REPLAY_NOTE)
    if not isinstance(m, dict):
        kw: dict[str, Any] = {"content": [TextContent(type="text", text="\n".join(lines)), *result.content[1:]]}
        if s:
            kw["structuredContent"] = s
        if getattr(result, "is_error", None) or getattr(result, "isError", None):
            kw["isError"] = True
        return CallToolResult(**kw)
    new = {**s, "mws": {**m, "replayed": True}}
    kwargs: dict[str, Any] = {
        "content": [TextContent(type="text", text="\n".join(lines)), TextContent(type="text", text=q(new))],
        "structuredContent": new,
    }
    if _IS_ERROR.get(str(m.get("outcome")), True):
        kwargs["isError"] = True
    return CallToolResult(**kwargs)


def read_answer(value: Mapping[str, Any], text: str | None = None) -> CallToolResult:
    """The answer of a read tool: ``value`` in ``structuredContent`` and, unless ``text`` is given,
    the same value as JSON in the text block. Not a write result."""
    kwargs: dict[str, Any] = {
        "content": [TextContent(type="text", text=text if text is not None else q(value))],
        "structuredContent": dict(value),  # camelCase works with both SDK lines
    }
    return CallToolResult(**kwargs)
