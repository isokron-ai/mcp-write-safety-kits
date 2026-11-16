"""Regression tests for the pre-release review: B-9 rules the builders enforce, error classification,
the reader rules, strict patterns and bounded memory."""

from __future__ import annotations

import asyncio
from typing import Any

import pytest
from mcp.types import CallToolResult
from pydantic import BaseModel

import mws_kit as k
from conftest import call, run
from mws_kit._mcp import structured_of, text_of

try:
    from mcp.server.mcpserver import MCPServer as FastMCP
except ImportError:  # pragma: no cover - depends on the installed SDK
    from mcp.server.fastmcp import FastMCP  # type: ignore[no-redef]

RW = k.read_with("get_note", id="n-1")


def mws(r: CallToolResult) -> dict[str, Any]:
    return structured_of(r)["mws"]


# -- a ValidationError raised inside the handler is not an argument refusal ---------------------


class _Answer(BaseModel):
    id: int


def test_validation_error_after_the_write_is_an_unknown_outcome_not_a_refusal():
    server = FastMCP("t")
    kit = k.WriteSafety(server)
    written: list[str] = []

    @kit.read_tool(open_world=False)
    def get_note(id: str) -> CallToolResult:  # noqa: A002
        return k.read_answer({"id": id})

    @kit.write_tool(read_tool="get_note", read_arguments={"id": "id"})
    def save(id: str) -> CallToolResult:  # noqa: A002
        written.append(id)
        _Answer.model_validate({"id": "not a number"})  # the backend's answer cannot be parsed
        return k.applied("saved")

    r = run(call(server, "save", {"id": "a"}))
    assert written == ["a"]
    assert r.shape["outcome"] == "unknown"
    assert r.shape["code"] == "internal_error"
    assert r.shape["read_with"] == {"tool": "get_note", "arguments": {"id": "a"}}
    assert "Nothing was changed" not in r.text


# -- error classification ---------------------------------------------------------------------


def test_timeout_raised_while_handling_a_refused_connection_is_unknown():
    def write() -> CallToolResult:
        try:
            raise ConnectionRefusedError()
        except ConnectionRefusedError:
            raise TimeoutError() from None  # a fallback host timed out

    try:
        write()
    except TimeoutError as e:
        assert k.classify_error(e) == "unknown"
    r = k.guard_write(write, read_with=RW, what="the update was sent")
    assert mws(r)["outcome"] == "unknown" and mws(r)["code"] == "no_answer"
    assert mws(r)["repeat"] == "read_first"


def test_timeout_raised_from_a_refused_connection_is_still_unknown():
    def write() -> CallToolResult:
        try:
            raise ConnectionRefusedError()
        except ConnectionRefusedError as inner:
            raise TimeoutError() from inner

    r = k.guard_write(write, read_with=RW, what="the update was sent")
    assert mws(r)["outcome"] == "unknown"


def test_a_bug_is_internal_error_not_no_answer():
    def write() -> CallToolResult:
        raise KeyError("x")

    r = k.guard_write(write, read_with=RW, what="the update may have been sent")
    assert mws(r)["outcome"] == "unknown" and mws(r)["code"] == "internal_error"
    r2 = k.guard_write(lambda: (_ for _ in ()).throw(k.OutcomeUnknownError("timeout after 30 s")), read_with=RW, what="w")
    assert mws(r2)["code"] == "no_answer"


# -- the text names the read wherever read_with is given ----------------------------------------


@pytest.mark.parametrize(
    "build",
    [
        lambda: k.applied("x", read_with=RW),
        lambda: k.accepted("x", read_with=RW),
        lambda: k.not_applied("x", code="locked", read_with=RW),
    ],
)
def test_text_names_the_read(build):
    assert '"get_note"' in text_of(build()).split("\n", 1)[0] + text_of(build())


# -- repeat rules -------------------------------------------------------------------------------


def test_read_first_needs_read_with_or_object_id():
    with pytest.raises(k.ShapeError):
        k.partial("x", items=[k.item(0, "applied"), k.item(1, "not_applied")])
    ok = k.partial("x", items=[k.item(0, "applied"), k.item(1, "not_applied")], object={"id": "nb-1"})
    assert mws(ok)["repeat"] == "read_first"


def test_repeat_yes_after_an_applied_delete_is_refused():
    with pytest.raises(k.ShapeError):
        k.applied("deleted", operation="delete", repeat="yes")


def test_same_key_and_same_version_need_the_guard_the_call_carried():
    with pytest.raises(k.ShapeError):
        k.not_applied("x", repeat="same_key")
    with pytest.raises(k.ShapeError):
        k.partial("x", items=[k.item(0, "applied"), k.item(1, "not_applied")], repeat="same_version", read_with=RW)
    r = k.partial("x", items=[k.item(0, "applied"), k.item(1, "not_applied")], repeat="same_key", key=("idempotency_key", "k1"), read_with=RW)
    assert mws(r)["repeat"] == "same_key"


def test_partial_refuses_an_open_item():
    with pytest.raises(k.ShapeError):
        k.partial("x", items=[k.item(0, "unknown"), k.item(1, "not_applied")], read_with=RW)
    with pytest.raises(k.ShapeError):
        k.not_applied("x", items=[k.item(0, "unknown")])


# -- conflict ------------------------------------------------------------------------------------


def test_empty_current_version_is_left_out():
    r = k.conflict("n-1", current_state={"t": 1}, read_tool="get_note", current_version="")
    assert "current_version" not in mws(r)["conflict"]
    assert "version_argument" not in mws(r)


# -- reader rules ---------------------------------------------------------------------------------


def _raw(m: dict[str, Any]) -> CallToolResult:
    return CallToolResult(content=[], structuredContent={"mws": m})


def test_reader_drops_unknown_and_malformed_members():
    got = k.read_result(_raw({"shape": "write-result/0.1", "outcome": "applied", "repeat": 42, "x": 1, "changed": ["/a"], "object": {"id": True, "version": 3}}))
    assert got == {"shape": "write-result/0.1", "outcome": "applied", "changed": ["/a"], "object": {"version": 3}}
    # B-9: the other members are still read where outcome is malformed; outcome is then absent.
    assert k.read_result(_raw({"shape": "write-result/0.1", "outcome": "weird", "code": "no_answer"})) == {"shape": "write-result/0.1", "code": "no_answer"}
    # Before 1.0, a reader reads only the version it knows.
    assert k.read_result(_raw({"shape": "write-result/0.7", "outcome": "applied"})) is None
    assert k.read_result(_raw({"shape": "write-result/0", "outcome": "applied"})) is None
    assert k.read_result(_raw({"shape": "write-result/1.0", "outcome": "applied"})) is None


# -- idempotency: a stored unknown outcome says how to settle it ------------------------------------


def test_stored_unknown_outcome_tells_the_caller_to_read_then_use_a_new_key():
    idem = k.Idempotency()

    def lost() -> CallToolResult:
        raise TimeoutError()

    first = idem.run(scope="s", key="k", arguments={}, write=lost, read_with=RW)
    again = idem.run(scope="s", key="k", arguments={}, write=lost, read_with=RW)
    for r in (first, again):
        assert mws(r)["repeat"] == "read_first" and mws(r)["read_with"] == RW
        assert "new idempotency_key" in text_of(r)


def test_in_memory_store_purges_expired_records_on_reserve():
    now = [0.0]
    store = k.InMemoryIdempotencyStore(clock=lambda: now[0], purge_every=10)
    for i in range(100):
        store.reserve("s", f"k{i}", "fp", ttl=5)
    now[0] = 11
    store.reserve("s", "fresh", "fp", ttl=5)
    assert len(store) == 1


# -- version guard: the lock table does not grow ---------------------------------------------------


def test_version_guard_drops_idle_locks():
    data = {f"n-{i}": {"v": "1"} for i in range(50)}
    g: k.VersionGuard[Any] = k.VersionGuard(
        read=lambda id: k.Snapshot(dict(data[id]), data[id]["v"]),
        write=lambda id, ch, ev: k.Snapshot({"v": "2"}, "2"),
        read_tool="get_note",
        version_field="v",
    )
    for i in range(50):
        g.apply(f"n-{i}", "1", {})
    assert g._locks == {}

    async def both() -> None:
        await asyncio.gather(*(g.apply_async(f"n-{i}", "2", {}) for i in range(50)))

    run(both())
    assert g._locks == {}


# -- strict patterns follow ECMA-262 ----------------------------------------------------------------


def test_pattern_dollar_does_not_match_before_a_final_newline():
    schema = k.strict_schema({"type": "object", "properties": {"id": {"type": "string", "pattern": "^n-[0-9]+$"}}})
    assert k.check_arguments(schema, {"id": "n-3"}) == []
    assert k.check_arguments(schema, {"id": "n-3\n"})
    digits = k.strict_schema({"type": "object", "properties": {"n": {"type": "string", "pattern": "^\\d+$"}}})
    assert k.check_arguments(digits, {"n": "١٢"})


def test_bad_schema_keywords_are_refused_at_definition_time():
    for bad in (
        {"type": "string", "pattern": "("},
        {"type": "number", "exclusiveMinimum": True},
        {"type": "object", "required": "a"},
        {"type": "object", "properties": {"a": {"$ref": "https://example.com/s.json"}}},
    ):
        with pytest.raises(k.UnsupportedSchema):
            k.strict_schema(bad)


# -- an error after the handler returned is never an argument refusal ------------------------------


def test_plain_return_value_after_a_write_is_not_an_argument_refusal():
    server = FastMCP("t")
    kit = k.WriteSafety(server)
    written: list[str] = []

    @kit.read_tool(open_world=False)
    def get_note(id: str) -> CallToolResult:  # noqa: A002
        return k.read_answer({"id": id})

    @kit.write_tool(read_tool="get_note", read_arguments={"id": "id"})
    def save(id: str) -> Any:  # noqa: A002 - an existing handler that returns plain text
        written.append(id)
        return "done"

    r = run(call(server, "save", {"id": "a"}))
    assert written == ["a"]
    if r.structured is not None and "mws" in r.structured:  # SDK 1.x refuses the plain return value
        assert r.shape["outcome"] == "unknown" and r.shape["code"] != "invalid_argument"
        assert "Nothing was changed" not in r.text


def test_sdk_argument_validation_still_refuses_before_the_handler():
    server = FastMCP("t")
    kit = k.WriteSafety(server, strict=False)
    written: list[int] = []

    @kit.read_tool(open_world=False)
    def get_note(id: str) -> CallToolResult:  # noqa: A002
        return k.read_answer({"id": id})

    @kit.write_tool(read_tool="get_note")
    def save(count: int) -> CallToolResult:
        written.append(count)
        return k.applied("saved")

    r = run(call(server, "save", {"count": "not a number"}))
    assert written == []
    assert r.shape["outcome"] == "not_applied" and r.shape["code"] == "invalid_argument"


def test_pattern_dot_and_whitespace_follow_ecma():
    schema = k.strict_schema({"type": "object", "properties": {"s": {"type": "string", "pattern": "^.+$"}, "w": {"type": "string", "pattern": "^\\s$"}}})
    assert k.check_arguments(schema, {"s": "a\rb"})
    assert k.check_arguments(schema, {"s": "ab", "w": " "}) == []
