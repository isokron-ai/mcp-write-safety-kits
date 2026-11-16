"""The write-result shape, version 0.1 (MWS 0.9, Annex B, B-9), and the builders that produce it.

A write tool's result carries the shape as the member ``mws`` of ``structuredContent``; the tool's
own output, if any, sits beside it. The content has two text blocks:

1. a statement generated from the shape: the outcome in the spec's words ("Applied:", "Not
   applied:", "Partly applied:", "Outcome unknown:", "Accepted:"), the reason, the items, and the
   read to make. It never restates ``conflict.current_state`` in prose;
2. ``structuredContent`` serialized as compact JSON, so that it parses back equal to it.

::

    {"mws": {"shape": "write-result/0.1",
             "outcome": "applied" | "not_applied" | "partial" | "unknown" | "accepted",
             "repeat": "no" | "yes" | "same_key" | "same_version" | "read_first",
             "operation": "create" | "update" | "delete" | <command>,
             "object": {"type", "id", "version", "scope", "parent": {"type", "id", "version"}},
             "changed": ["/title", ...],                  # JSON Pointers; [] = nothing changed
             "replayed": true,
             "items": [{"index", "step", "id", "version", "outcome", "code", "message", "conflict"}],
             "applied_count": 3,
             "code": "...", "message": "...",
             "argument": "/title",
             "argument_errors": [{"argument", "code", "message"}],
             "conflict": {"current_version", "checked_by", "current_state", "omitted", "held_by"},
             "read_with": {"tool": "get_note", "arguments": {"id": "n-3"}},
             "version_argument": "expected_version"}}

Identifiers and versions are a string or an integer, in the JSON type the tool's argument for the
value accepts (an integer beyond 2^53-1 is given as a string). The kit writes ``isError: true`` for
``not_applied``, ``partial`` and ``unknown``.
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
    "conflict_info",
    "opening_line",
    "render_text",
    "assert_shape",
    "to_tool_result",
    "applied",
    "accepted",
    "not_applied",
    "partial",
    "conflict",
    "restate",
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

#: The 14 codes that version 0.1 reserves, with the outcome each one goes with.
CODES: dict[str, str] = {
    "conflict": "not_applied",
    "locked": "not_applied",
    "version_required": "not_applied",
    "invalid_argument": "not_applied",
    "not_found": "not_applied",
    "idempotency_key_reused": "not_applied",
    "in_progress": "unknown",
    "key_not_known": "unknown",
    "unavailable": "not_applied",
    # Writes are disabled (a read-only mode or a setting), the tool is switched off, or the caller may not make this
    # write: a repeat meets it again, so ``repeat`` stays ``no``.
    "not_permitted": "not_applied",
    "not_sent": "not_applied",
    "no_answer": "unknown",
    "backend_error": "unknown",
    "internal_error": "unknown",
}

_OUTCOMES = ("applied", "not_applied", "partial", "unknown", "accepted")
_REPEATS = ("no", "yes", "same_key", "same_version", "read_first")
_ITEM_OUTCOMES = ("applied", "not_applied", "not_attempted", "unknown")
_IS_ERROR = {"applied": False, "accepted": False, "not_applied": True, "partial": True, "unknown": True}
_CODE_RE = re.compile(r"^[a-z0-9_]+$")
_MAX_INT = 2**53 - 1

#: The line added to the first text block of a replayed result (``mws.replayed: true``).
REPLAY_NOTE = (
    "Replay: this call repeats an earlier call with the same idempotency key and applied nothing itself; "
    "the answer describes the earlier call's write."
)


class ReadWith(TypedDict):
    tool: str
    arguments: dict[str, Any]


class ShapeError(TypeError):
    """A result breaks a rule of the shape."""


def q(value: Any) -> str:
    """A value quoted for a sentence, as compact JSON, so that it can be read only one way."""
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)


def pointer(*path: str | int) -> str:
    """A JSON Pointer (RFC 6901) from path segments: ``pointer("details", "severity")`` is
    ``"/details/severity"``; ``pointer()`` is ``""``, the whole object."""
    return "".join("/" + str(p).replace("~", "~0").replace("/", "~1") for p in path)


def _unpointer(p: str) -> str:
    """A pointer as a reader names the argument: ``"/details/a~1b"`` -> ``details/a/b``."""
    return p[1:].replace("~1", "/").replace("~0", "~") if p.startswith("/") else p


def read_with(tool: str, **arguments: Any) -> ReadWith:
    """The ``read_with`` member: a read tool, and arguments that address the object written."""
    return {"tool": tool, "arguments": dict(arguments)}


def _idv(v: Any) -> str | int:
    """An identifier or version: a string or an integer, kept in its type; an integer beyond
    2^53-1 becomes a string."""
    if isinstance(v, bool):
        raise ShapeError("an identifier or version is a string or an integer, not a boolean")
    if isinstance(v, int):
        return v if -_MAX_INT <= v <= _MAX_INT else str(v)
    return v if isinstance(v, str) else str(v)


def conflict_info(
    *,
    current_version: Any = None,
    checked_by: Literal["backend", "server"] | None = None,
    current_state: Mapping[str, Any] | None = None,
    omitted: Sequence[str] = (),
    held_by: str | None = None,
) -> dict[str, Any]:
    """A ``conflict`` object, for the top level or for one item. ``current_version`` is left out,
    never ``null``, where the backend has none."""
    c: dict[str, Any] = {}
    if current_version is not None and current_version != "":  # never null or a placeholder
        c["current_version"] = _idv(current_version)
    if checked_by is not None:
        c["checked_by"] = checked_by
    if current_state is not None:
        c["current_state"] = dict(current_state)
    if omitted:
        c["omitted"] = list(omitted)
    if held_by is not None:
        c["held_by"] = held_by
    return c


def item(
    index: int | None = None,
    outcome: ItemOutcome = "applied",
    *,
    id: Any = None,  # noqa: A002 - the shape's member name
    version: Any = None,
    step: str | None = None,
    code: str | None = None,
    message: str | None = None,
    conflict: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """One entry of ``items``. An item of a list the call gave has ``index`` (from 0), and ``id``
    where the object exists after the call; a step has ``step``; an object a selector matched has
    ``id`` and no ``index``."""
    if index is None and step is None and id is None:
        raise ShapeError("an item has index, step or id")
    out: dict[str, Any] = {}
    if index is not None:
        out["index"] = index
    if step is not None:
        out["step"] = step
    if id is not None:
        out["id"] = _idv(id)
    if version is not None:
        out["version"] = _idv(version)
    out["outcome"] = outcome
    if code is not None:
        out["code"] = code
    if message is not None:
        out["message"] = message
    if conflict is not None:
        out["conflict"] = dict(conflict)
    return out


def _object(obj: Mapping[str, Any] | None) -> dict[str, Any] | None:
    if obj is None:
        return None
    out: dict[str, Any] = {}
    for k in ("type", "id", "version", "scope", "parent"):
        v = obj.get(k)
        if v is None:
            continue
        if k in ("id", "version"):
            out[k] = _idv(v)
        elif k == "parent":
            out[k] = {
                pk: (_idv(pv) if pk in ("id", "version") else str(pv))
                for pk, pv in v.items()
                if pk in ("type", "id", "version") and pv is not None
            }
        else:
            out[k] = str(v)
    return out


# ------------------------------------------------------------------------------------------------
# Text


def _sentence(s: str) -> str:
    t = s.strip()
    return t if not t or t[-1] in ".!?" else f"{t}."


def _read_sentence(m: Mapping[str, Any]) -> str | None:
    rw = m.get("read_with")
    if not rw:
        return None
    return f"read it with {q(rw['tool'])} and the arguments {q(rw.get('arguments', {}))}"


_OPENING = {
    "applied": "Applied",
    "accepted": "Accepted",
    "not_applied": "Not applied",
    "partial": "Partly applied",
    "unknown": "Outcome unknown",
}
_SUFFIX = {
    "not_applied": " Nothing was changed.",
    "partial": " Some items remain applied; the JSON below gives the outcome of each.",
    "unknown": " It is not known whether the change was applied.",
    "accepted": " The backend has not yet reported the result.",
}
def opening_line(m: Mapping[str, Any], summary: str) -> str:
    """The first line of the first text block: the outcome's words, the summary, and the sentence
    the outcome implies."""
    return _sentence(f"{_OPENING[m['outcome']]}: {summary}") + _SUFFIX.get(m["outcome"], "")


def render_text(
    structured: Mapping[str, Any],
    summary: str,
    notes: Iterable[str] = (),
    *,
    key: tuple[str | None, Any] | None = None,
    version: tuple[str | None, Any] | None = None,
    opening: str | None = None,
) -> str:
    """The first text block, generated from the shape by the same rules as the TypeScript kit's
    ``renderText`` (the shared golden file ``tests/golden/first-sentence.json`` pins them).

    It states the outcome in plain words, marks a replay, says that a conflict's state is in the
    JSON below (never restating it), names the changed fields and the version now, gives the
    instruction that ``repeat`` implies, and names the read. ``summary`` is one sentence without a
    final period, every value quoted (use :func:`q`). ``key`` (argument, value) and ``version``
    (argument, value) let the text name the guard behind ``same_key`` or ``same_version``.
    ``opening`` replaces the first line (used to restate a stored result).
    """
    m = structured["mws"]
    outcome = m["outcome"]
    lines = [opening if opening is not None else opening_line(m, summary)]
    if m.get("replayed"):
        lines.append(REPLAY_NOTE)
    c = m.get("conflict")
    if c and ("current_state" in c or "current_version" in c):
        st, ver = "current_state" in c, "current_version" in c
        what = "state and version are" if st and ver else "state is" if st else "version is"
        lines.append(f"Its current {what} in the JSON below.")
    if "changed" in m:
        ch = m["changed"]
        lines.append(f"Changed: {', '.join(q(x) for x in ch) if ch else 'nothing'}.")
    obj = m.get("object")
    if obj is not None and "version" in obj and outcome != "not_applied":
        lines.append(f"Version now: {q(obj['version'])}.")
    read = _read_sentence(m)
    rep = m.get("repeat")
    if rep == "no":
        lines.append("Do not send the same call again.")
        if read:
            lines.append(f"To see the current state, {read}.")
    elif rep == "yes":
        lines.append("The same call can be sent again unchanged; it cannot apply the write more than once.")
        if read:
            lines.append(f"To see the current state, {read}.")
    elif rep == "same_key":
        arg = (key[0] if key and key[0] else None) or "idempotency key"
        val = f" {q(key[1])}" if key and key[1] is not None else ""
        lines.append(f"Send the call again only with the same {arg}{val}" + (f", or first {read}" if read else "") + ".")
    elif rep == "same_version":
        arg = m.get("version_argument") or "version"
        val = f" {q(version[1])}" if version and version[1] is not None else ""
        lines.append(f"Send the call again only with the same {arg}{val}" + (f"; or first {read}" if read else "") + ".")
    elif rep == "read_first":
        if c and "current_state" in c and not c.get("omitted"):
            lines.append(
                "Build the write again from them" + (f", or {read}" if read else "")
                + "; do not resend your earlier values with the new version."
            )
        else:
            lines.append(f"Before writing again, {read or 'read the object'} and build the write from what the read shows.")
    elif read:
        lines.append(f"To see the current state, {read}.")
    for n in notes:
        lines.append(_sentence(n))
    return "\n".join(lines)


# ------------------------------------------------------------------------------------------------
# Rules


def _is_idv(v: Any) -> bool:
    return isinstance(v, str) or (isinstance(v, int) and not isinstance(v, bool) and -_MAX_INT <= v <= _MAX_INT)


def _is_ptr(v: Any) -> bool:
    return isinstance(v, str) and (v == "" or v.startswith("/"))


def assert_shape(structured: Mapping[str, Any]) -> None:
    """Checks a ``structuredContent`` against the rules of B-9 that a producer can check. Raises
    :class:`ShapeError` naming the first rule broken."""

    def fail(msg: str) -> None:
        raise ShapeError(f"{SHAPE}: {msg}")

    def check_conflict(c: Any, where: str) -> None:
        if not isinstance(c, Mapping):
            fail(f"{where} is an object")
        if "current_version" in c and not _is_idv(c["current_version"]):
            fail(f"{where}.current_version is a string or an integer within 2^53-1")
        if c.get("current_version") == "":
            fail(f"{where}.current_version is never empty: leave it out where there is none")
        if c.get("checked_by") not in (None, "backend", "server"):
            fail(f'{where}.checked_by is "backend" or "server"')
        if "current_state" in c and not isinstance(c["current_state"], Mapping):
            fail(f"{where}.current_state is an object")
        if any(not _is_ptr(o) for o in c.get("omitted", [])):
            fail(f"{where}.omitted holds JSON Pointers")

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
    if rep == "yes" and o != "not_applied":
        fail(f'repeat "yes" goes only with not_applied, not {q(o)} (MWS-RES-2: kind retry-invited)')
    if rep == "same_key" and o == "not_applied":
        fail('repeat "same_key" does not go with not_applied')
    if rep == "same_version" and o not in ("unknown", "applied"):
        fail('repeat "same_version" goes only with unknown or applied')
    code = m.get("code")
    if code is not None:
        if not (isinstance(code, str) and _CODE_RE.match(code)):
            fail("mws.code must be lowercase letters, digits and underscores")
        if code in CODES and CODES[code] != o:
            fail(f"code {q(code)} goes with outcome {q(CODES[code])}, not {q(o)}")
    if code == "conflict" and rep != "read_first":
        fail('a result whose code is "conflict" has repeat "read_first"')
    if code == "conflict" and "read_with" not in m:
        fail('a result whose code is "conflict" names the read in read_with')
    obj = m.get("object")
    if obj is not None:
        for k in ("id", "version"):
            if k in obj and not _is_idv(obj[k]):
                fail(f"mws.object.{k} is a string or an integer within 2^53-1")
        for k in ("type", "scope"):
            if k in obj and not isinstance(obj[k], str):
                fail(f"mws.object.{k} is a string")
        par = obj.get("parent")
        if par is not None and (not isinstance(par, Mapping) or any(k in par and not _is_idv(par[k]) for k in ("id", "version"))):
            fail("mws.object.parent is an object whose id and version are strings or integers")
        if o == "not_applied" and "version" in obj:
            fail("on not_applied, object.version is left out (the current version goes in conflict)")
        if o == "accepted" and "version" in obj:
            fail("accepted gives no object.version: it would say the change was made")
    if o == "accepted" and "changed" in m:
        fail("accepted gives no changed: it would say the change was made")
    if any(not _is_ptr(c) for c in m.get("changed", [])):
        fail("mws.changed holds JSON Pointers")
    if "argument" in m and not _is_ptr(m["argument"]):
        fail("mws.argument is a JSON Pointer into the arguments")
    for e in m.get("argument_errors", []):
        if not isinstance(e, Mapping) or not _is_ptr(e.get("argument")):
            fail("each argument_errors entry has an argument (a JSON Pointer)")
        if "code" in e and not (isinstance(e["code"], str) and _CODE_RE.match(e["code"])):
            fail("argument_errors[].code must be lowercase letters, digits and underscores")
    for it in m.get("items", []):
        if not isinstance(it, Mapping) or it.get("outcome") not in _ITEM_OUTCOMES:
            fail("each item has an outcome of applied, not_applied, not_attempted or unknown")
        if not any(k in it for k in ("index", "step", "id")):
            fail("each item has index, step or id")
        if "index" in it and not (isinstance(it["index"], int) and not isinstance(it["index"], bool) and it["index"] >= 0):
            fail("items[].index is an integer from 0")
        for k in ("id", "version"):
            if k in it and not _is_idv(it[k]):
                fail(f"items[].{k} is a string or an integer within 2^53-1")
        if "conflict" in it:
            check_conflict(it["conflict"], "items[].conflict")
    if o in ("not_applied", "applied"):
        outs = [it.get("outcome") for it in m.get("items", [])]
        if "unknown" in outs:
            fail(f"an item with an open outcome makes the whole outcome unknown, not {o}")
        if o == "not_applied" and "applied" in outs:
            fail("not_applied says no change is in effect; an applied item makes it partial")
    if o == "partial":
        outs = [it.get("outcome") for it in m.get("items", [])]
        if "unknown" in outs:
            fail("an item with an open outcome makes the whole outcome unknown, not partial")
        if not ("applied" in outs or m.get("applied_count")) or not any(x in ("not_applied", "not_attempted") for x in outs):
            fail("partial needs at least one item applied and one not")
    if "applied_count" in m and not (isinstance(m["applied_count"], int) and m["applied_count"] >= 0):
        fail("mws.applied_count is an integer from 0")
    c = m.get("conflict")
    if c is not None:
        if code not in ("conflict", "locked"):
            fail('mws.conflict is present only where code is "conflict" or "locked"')
        check_conflict(c, "mws.conflict")
    rw = m.get("read_with")
    if rw is not None and not (isinstance(rw, Mapping) and isinstance(rw.get("tool"), str) and rw["tool"]
                               and isinstance(rw.get("arguments"), Mapping)):
        fail("mws.read_with is {tool, arguments}")
    if rep == "read_first" and rw is None and not (isinstance(obj, Mapping) and obj.get("id") is not None):
        fail('repeat "read_first" names a read only with read_with or object.id; give read_with')
    if "replayed" in m and m["replayed"] is not True:
        fail("mws.replayed is true or left out")


def _build(structured: dict[str, Any], text: str) -> CallToolResult:
    kwargs: dict[str, Any] = {
        "content": [TextContent(type="text", text=text), TextContent(type="text", text=q(structured))],
        "structuredContent": structured,
    }
    if _IS_ERROR[structured["mws"]["outcome"]]:
        kwargs["isError"] = True
    return CallToolResult(**kwargs)


def to_tool_result(
    mws: Mapping[str, Any],
    summary: str,
    notes: Iterable[str] = (),
    *,
    data: Mapping[str, Any] | None = None,
    key: tuple[str, Any] | None = None,
    version: tuple[str, Any] | None = None,
) -> CallToolResult:
    """Builds the tool result: ``structuredContent = {**data, "mws": mws}``, the statement in the
    first text block, the serialized ``structuredContent`` in the second, and ``isError`` as the
    outcome implies. Checks the shape first (:func:`assert_shape`).

    ``data`` is the tool's own output; give it on ``applied`` (the tool's ``outputSchema`` requires
    the tool's own members only there).
    """
    m = {"shape": SHAPE, **{k: v for k, v in mws.items() if v is not None and k != "shape"}}
    if data is not None and "mws" in data:
        raise ShapeError("the tool's own output may not use the member name mws")
    structured = {**(dict(data) if data else {}), "mws": m}
    assert_shape(structured)
    # B-9: same_key and same_version name a guard only where the call carried one.
    if m.get("repeat") == "same_key" and not m.get("replayed") and not (key and key[1] is not None):
        raise ShapeError('repeat "same_key" only where the call carried an idempotency key: pass key=(argument, value)')
    if m.get("repeat") == "same_version" and not m.get("replayed") and not (version and version[1] is not None):
        raise ShapeError('repeat "same_version" only where the call carried a version: pass version=(argument, value)')
    return _build(structured, render_text(structured, summary, notes, key=key, version=version))


def restate(
    result: CallToolResult,
    changes: Mapping[str, Any],
    *,
    key: tuple[str, Any] | None = None,
    version: tuple[str, Any] | None = None,
    notes: Iterable[str] = (),
) -> CallToolResult:
    """The same result with members of ``mws`` changed (``None`` removes one): the first text
    block is generated again from the new shape, keeping its first line, with ``notes`` after it,
    and the JSON block is serialized again."""
    s = structured_of(result)
    if not isinstance(s, dict) or not isinstance(s.get("mws"), dict):
        raise ShapeError("restate needs a result that carries the shape")
    m = {k: v for k, v in {**s["mws"], **changes}.items() if v is not None}
    new = {**s, "mws": m}
    assert_shape(new)
    texts = [getattr(b, "text", "") for b in result.content if getattr(b, "type", None) == "text"]
    first = (texts[0] if texts else "").split("\n")[0]
    return _build(new, render_text(new, "", notes, key=key, version=version, opening=first))


# ------------------------------------------------------------------------------------------------
# Builders


def _after_success(key: tuple[str, Any] | None, version: tuple[str, Any] | None) -> Repeat:
    if key is not None:
        return "same_key"
    if version is not None:
        return "same_version"
    return "no"


def applied(
    summary: str,
    *,
    object: Mapping[str, Any] | None = None,  # noqa: A002 - the shape's member name
    changed: Sequence[str] | None = None,
    operation: str | None = None,
    repeat: Repeat | None = None,
    key: tuple[str, Any] | None = None,
    version: tuple[str, Any] | None = None,
    items: Sequence[Mapping[str, Any]] | None = None,
    applied_count: int | None = None,
    read_with: ReadWith | None = None,
    data: Mapping[str, Any] | None = None,
    notes: Iterable[str] = (),
) -> CallToolResult:
    """A receipt: the state asked for is in effect (MWS-RES-1, RES-3, RES-4).

    - ``object``: the object written, with its version after the write, and ``parent`` for an
      object written inside another.
    - ``changed``: JSON Pointers into the object as the read tool returns it. ``[]`` says nothing
      changed; a create lists the fields the call set (no server-managed fields, defaults or scope
      argument), or ``[""]``; a delete leaves it out.
    - ``repeat``: by default ``same_key`` where the call carried an idempotency key (``key``:
      argument name and value), ``same_version`` where it carried a version (``version``), else
      ``no``. Never ``yes``.
    - A write by selector that matched nothing: ``applied_count=0, items=[]``.
    """
    return to_tool_result(
        {
            "outcome": "applied",
            "repeat": repeat or _after_success(key, version),
            "operation": operation,
            "object": _object(object),
            "changed": list(changed) if changed is not None else None,
            "items": [dict(i) for i in items] if items is not None else None,
            "applied_count": applied_count,
            "read_with": read_with,
            "version_argument": version[0] if version is not None and repeat in (None, "same_version") else None,
        },
        summary,
        notes,
        data=data,
        key=key,
        version=version,
    )


def accepted(
    summary: str,
    *,
    object: Mapping[str, Any] | None = None,  # noqa: A002
    operation: str | None = None,
    key: tuple[str, Any] | None = None,
    read_with: ReadWith | None = None,
    data: Mapping[str, Any] | None = None,
    notes: Iterable[str] = (),
) -> CallToolResult:
    """For an operation that the backend completes asynchronously only: the backend accepted the
    request and has not yet reported the result (NF-19). On any other operation a tester reads it
    as a report of success. No ``changed`` and no ``object.version``. ``repeat`` is ``same_key``
    where the call carried a key, else ``no``."""
    obj = _object(object)
    if obj is not None:
        obj.pop("version", None)
    return to_tool_result(
        {"outcome": "accepted", "repeat": _after_success(key, None), "operation": operation, "object": obj, "read_with": read_with},
        summary,
        notes,
        data=data,
        key=key,
    )


def not_applied(
    summary: str,
    *,
    code: str | None = None,
    message: str | None = None,
    argument: str | None = None,
    argument_errors: Sequence[Mapping[str, Any]] | None = None,
    object: Mapping[str, Any] | None = None,  # noqa: A002
    operation: str | None = None,
    repeat: Repeat | None = None,
    items: Sequence[Mapping[str, Any]] | None = None,
    read_with: ReadWith | None = None,
    notes: Iterable[str] = (),
) -> CallToolResult:
    """A refusal: no change made by the call is in effect (``isError: true``; MWS-RES-2, CONC-4,
    IN-4).

    ``repeat`` defaults to ``yes`` for ``not_sent`` and ``unavailable``, ``read_first`` for
    ``conflict``, and ``no`` otherwise. An all-or-nothing refusal of several items gives every
    item: the bad ones ``not_applied`` with their code, the rest ``not_attempted``; where ``code``
    is not given it is the first bad item's code. A refusal because of several objects' versions
    puts a ``conflict`` in each item and none at the top level.
    """
    if code is None and items:
        code = next((i.get("code") for i in items if i.get("outcome") == "not_applied" and i.get("code")), None)
    if repeat is None:
        repeat = "yes" if code in ("not_sent", "unavailable") else "read_first" if code == "conflict" else "no"
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
            "argument_errors": [dict(e) for e in argument_errors] if argument_errors is not None else None,
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
    object: Mapping[str, Any] | None = None,  # noqa: A002
    repeat: Repeat | None = None,
    key: tuple[str, Any] | None = None,
    read_with: ReadWith | None = None,
    notes: Iterable[str] = (),
) -> CallToolResult:
    """A write of several items or steps, each settled or not attempted, some applied and some not
    (MWS-ATOM-1, RES-2): never a success (``isError: true``). List every item. ``repeat`` is
    ``same_key`` where the call carried a key, else ``read_first``.

    With no item applied this is :func:`not_applied` with the items. An item whose outcome is open
    makes the whole outcome unknown: use :func:`mws_kit.unknown_outcome` with the items (this
    function refuses it). With ``repeat="read_first"`` (the default without a key) give
    ``read_with``, or an ``object`` with an ``id``.
    """
    outs = [i["outcome"] for i in items]
    if "unknown" in outs:
        raise ShapeError("an item with an open outcome makes the whole outcome unknown: use unknown_outcome(items=...)")
    if "applied" not in outs and not applied_count:
        return not_applied(summary, code=code, message=message, operation=operation, items=items, read_with=read_with, notes=notes)
    return to_tool_result(
        {
            "outcome": "partial",
            "repeat": repeat or ("same_key" if key else "read_first"),
            "operation": operation,
            "object": _object(object),
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
    read_tool: str,
    current_state: Mapping[str, Any] | None = None,
    current_version: Any = None,
    checked_by: Literal["backend", "server"] | None = None,
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
    """A write refused because the object changed since the state the call carried (``conflict``;
    MWS-CONC-2, CONC-4, CONC-6) or because of a lock (``locked``; CONC-1).

    ``repeat`` is ``read_first`` and ``read_with`` names the read. The current state is carried as
    JSON (only fields the caller may read through the read tool, never a secret; list what is left
    out in ``omitted``), the version on its own in the type the version argument takes, and
    ``checked_by`` says whose check refused the write.
    """
    default = f"{noun} {q(id)} changed since the version you read" if code == "conflict" else f"{noun} {q(id)} is locked"
    return to_tool_result(
        {
            "outcome": "not_applied",
            "repeat": "read_first",
            "operation": operation,
            "object": _object({"type": object_type, "id": id}),
            "code": code,
            "message": message or default,
            "conflict": conflict_info(
                current_version=current_version,
                checked_by=checked_by,
                current_state=current_state,
                omitted=omitted,
                held_by=held_by,
            ),
            "read_with": {"tool": read_tool, "arguments": {id_argument: id}},
            "version_argument": version_argument if current_version is not None and current_version != "" else None,
        },
        f"{default}, so the write was refused",
        notes,
    )


def _ptr(v: Any) -> bool:
    return isinstance(v, str) and (v == "" or v.startswith("/"))


def _read_conflict(c: Any) -> dict[str, Any] | None:
    if not isinstance(c, Mapping):
        return None
    cc: dict[str, Any] = {}
    if _is_idv(c.get("current_version")) and c["current_version"] != "":
        cc["current_version"] = c["current_version"]
    if c.get("checked_by") in ("backend", "server"):
        cc["checked_by"] = c["checked_by"]
    if isinstance(c.get("current_state"), Mapping):
        cc["current_state"] = dict(c["current_state"])
    om = c.get("omitted")
    if isinstance(om, list) and all(_ptr(p) for p in om):
        cc["omitted"] = list(om)
    if isinstance(c.get("held_by"), str):
        cc["held_by"] = c["held_by"]
    return cc


def _read_item(it: Any) -> dict[str, Any] | None:
    if not isinstance(it, Mapping) or it.get("outcome") not in _ITEM_OUTCOMES:
        return None
    out: dict[str, Any] = {}
    ix = it.get("index")
    if isinstance(ix, int) and not isinstance(ix, bool) and ix >= 0:
        out["index"] = ix
    if isinstance(it.get("step"), str):
        out["step"] = it["step"]
    for k in ("id", "version"):
        if _is_idv(it.get(k)):
            out[k] = it[k]
    if not any(k in out for k in ("index", "step", "id")):
        return None
    out["outcome"] = it["outcome"]
    if isinstance(it.get("code"), str) and _CODE_RE.match(it["code"]):
        out["code"] = it["code"]
    if isinstance(it.get("message"), str):
        out["message"] = it["message"]
    c = _read_conflict(it.get("conflict"))
    if c is not None:
        out["conflict"] = c
    return out


def read_result(result: CallToolResult) -> dict[str, Any] | None:
    """The ``mws`` member of a result, read as B-9's reader rules say; else None.

    Before 1.0 a reader reads only the version it knows: a result whose ``shape`` is not
    ``write-result/0.1`` is read as if it carried no shape (None). Members this version does not
    define, and members whose value does not have the form it gives them, are left out of what is
    returned: they decide nothing. The other members are still read where ``outcome`` is missing or
    malformed (it is then absent from what is returned).
    """
    s = structured_of(result)
    m = s.get("mws") if isinstance(s, dict) else None
    if not isinstance(m, Mapping) or m.get("shape") != SHAPE:
        return None
    out: dict[str, Any] = {"shape": SHAPE}
    if m.get("outcome") in _OUTCOMES:
        out["outcome"] = m["outcome"]
    if m.get("repeat") in _REPEATS:
        out["repeat"] = m["repeat"]
    for k in ("operation", "message", "version_argument"):
        if isinstance(m.get(k), str):
            out[k] = m[k]
    if isinstance(m.get("code"), str) and _CODE_RE.match(m["code"]):
        out["code"] = m["code"]
    if _ptr(m.get("argument")):
        out["argument"] = m["argument"]
    ob = m.get("object")
    if isinstance(ob, Mapping):
        obj: dict[str, Any] = {k: ob[k] for k in ("type", "scope") if isinstance(ob.get(k), str)}
        obj.update({k: ob[k] for k in ("id", "version") if _is_idv(ob.get(k))})
        par = ob.get("parent")
        if isinstance(par, Mapping):
            pp: dict[str, Any] = {"type": par["type"]} if isinstance(par.get("type"), str) else {}
            pp.update({k: par[k] for k in ("id", "version") if _is_idv(par.get(k))})
            obj["parent"] = pp
        out["object"] = obj
    ch = m.get("changed")
    if isinstance(ch, list) and all(_ptr(c) for c in ch):
        out["changed"] = list(ch)
    if m.get("replayed") is True:
        out["replayed"] = True
    if isinstance(m.get("items"), list):
        items = [_read_item(i) for i in m["items"]]
        out["items"] = [i for i in items if i is not None]
    ac = m.get("applied_count")
    if isinstance(ac, int) and not isinstance(ac, bool) and ac >= 0:
        out["applied_count"] = ac
    ae = m.get("argument_errors")
    if isinstance(ae, list):
        out["argument_errors"] = [
            {"argument": e["argument"], **{k: e[k] for k in ("code", "message") if isinstance(e.get(k), str) and (k != "code" or _CODE_RE.match(e[k]))}}
            for e in ae
            if isinstance(e, Mapping) and _ptr(e.get("argument"))
        ]
    rw = m.get("read_with")
    if isinstance(rw, Mapping) and isinstance(rw.get("tool"), str) and rw["tool"] and isinstance(rw.get("arguments"), Mapping):
        out["read_with"] = {"tool": rw["tool"], "arguments": dict(rw["arguments"])}
    c = _read_conflict(m.get("conflict"))
    if c is not None:
        out["conflict"] = c
    return out


def as_replay(result: CallToolResult, *, key: tuple[str, Any] | None = None) -> CallToolResult:
    """The first call's result, answered to a repeat with the same idempotency key: the same
    ``outcome``, ``code``, ``object`` and ``changed``, with ``replayed: true`` and
    ``repeat: "same_key"``; an open first answer keeps ``repeat: "read_first"``."""
    m = read_result(result)
    if m is None:
        raise ShapeError("as_replay needs a result that carries the shape")
    changes: dict[str, Any] = {"replayed": True}
    notes: list[str] = []
    if m.get("outcome") == "unknown" and m.get("repeat") == "read_first":
        # An open first answer: a repeat with the same key only replays it, so it stays read_first.
        if key is not None:
            notes.append(
                f"A repeat with the same {key[0]} {q(key[1])} applies nothing and returns this answer. If the read "
                f"shows that the write was not applied, send it again with a new {key[0]}"
            )
    elif m.get("outcome") != "not_applied":
        changes["repeat"] = "same_key"
    return restate(result, changes, key=key, notes=notes)


def read_answer(value: Mapping[str, Any], text: str | None = None) -> CallToolResult:
    """The answer of a read tool: ``value`` in ``structuredContent`` and, unless ``text`` is given,
    the same value as JSON in the text block. Not a write result."""
    kwargs: dict[str, Any] = {
        "content": [TextContent(type="text", text=text if text is not None else q(value))],
        "structuredContent": dict(value),
    }
    return CallToolResult(**kwargs)
