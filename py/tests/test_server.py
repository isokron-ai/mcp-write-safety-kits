"""WriteSafety on the SDK's high-level server (FastMCP in 1.x, MCPServer in 2.x), and annotations
(MWS-ANN-1 to ANN-4)."""

from __future__ import annotations

from typing import Any

import pytest
from mcp.types import CallToolResult

import mws_kit as k
from conftest import call, run

try:
    from mcp.server.mcpserver import MCPServer as FastMCP

    SDK = 2
except ImportError:  # pragma: no cover - depends on the installed SDK
    from mcp.server.fastmcp import FastMCP  # type: ignore[no-redef]

    SDK = 1


def schema_of(tool: Any) -> dict[str, Any]:
    return tool.model_dump(by_alias=True, exclude_none=True)["inputSchema"]


def annotations_of(tool: Any) -> dict[str, Any]:
    return tool.model_dump(by_alias=True, exclude_none=True)["annotations"]


def make() -> tuple[Any, k.WriteSafety, dict[str, Any]]:
    server = FastMCP("t")
    kit = k.WriteSafety(server)
    seen: dict[str, Any] = {}

    @server.tool()  # a plain SDK tool, for comparison
    def plain_set(flag: bool, count: int = 0) -> str:
        seen["plain"] = (flag, count)
        return "ok"

    @kit.write_tool(
        destructive=False,
        idempotent=True,
        open_world=False,
        read_tool="get_thing",
        output={"type": "object", "properties": {"flag": {"type": "boolean"}}, "required": ["flag"]},
    )
    def strict_set(flag: bool, count: int = 0) -> CallToolResult:
        seen["strict"] = (flag, count)
        return k.applied("set", object={"id": "t-1"}, changed=["/flag"], data={"flag": flag})

    @kit.read_tool(open_world=False)
    def get_thing(id: str) -> CallToolResult:  # noqa: A002
        return k.read_answer({"id": id})

    @kit.write_tool(read_tool="get_thing", read_arguments={"id": "id"})
    def crashes(id: str) -> CallToolResult:  # noqa: A002
        seen["crashed"] = id
        raise KeyError("internal detail with token=SECRET")

    @kit.write_tool(read_tool="get_thing", read_arguments={"id": "id"})
    def never_sent(id: str) -> CallToolResult:  # noqa: A002
        raise ConnectionRefusedError()

    @kit.read_tool()
    def read_crashes() -> CallToolResult:
        raise KeyError("x")

    return server, kit, seen


def test_sdk_default_converts_and_drops_but_the_kit_refuses():
    server, _, seen = make()
    # The SDK's default (pydantic lax mode, unknown arguments ignored): "true" becomes True, "5" becomes 5, and a
    # misspelled argument is dropped while the call succeeds. This is what MWS-IN-1, IN-2, IN-6 and IN-7 are about.
    r = run(call(server, "plain_set", {"flag": "true", "count": "5", "cuont": 9}))
    assert not r.is_error and seen["plain"] == (True, 5)
    r = run(call(server, "plain_set", {"flag": "yes"}))
    assert not r.is_error and seen["plain"] == (True, 0)

    # The kit's tool refuses each of them, names the argument, and nothing runs.
    for args, needle in [
        ({"flag": "true"}, 'Argument "flag": expected boolean, got string "true"'),
        ({"flag": True, "count": "5"}, 'Argument "count": expected integer, got string "5"'),
        ({"flag": True, "cuont": 9}, 'Argument "cuont": is not an argument of this tool and was not used (did you mean "count"?).'),
        ({}, 'Argument "flag": is required and was not sent'),
    ]:
        seen.pop("strict", None)
        r = run(call(server, "strict_set", args))
        assert r.is_error and needle in r.text, r
        assert r.shape["outcome"] == "not_applied" and r.shape["code"] == "invalid_argument"
        assert "strict" not in seen

    r = run(call(server, "strict_set", {"flag": False, "count": 2}))
    assert not r.is_error and seen["strict"] == (False, 2)


def test_advertised_schema_is_strict():
    server, kit, _ = make()
    tools = {t.name: t for t in run(server.list_tools())}
    assert schema_of(tools["strict_set"])["additionalProperties"] is False
    assert "additionalProperties" not in schema_of(tools["plain_set"])
    assert kit.unchecked_tools() == ["plain_set"]


def test_every_kit_tool_declares_all_four_hints():
    server, kit, _ = make()
    tools = {t.name: t for t in run(server.list_tools())}
    assert annotations_of(tools["strict_set"]) == {
        "readOnlyHint": False,
        "destructiveHint": False,
        "idempotentHint": True,
        "openWorldHint": False,
    }
    # The cautious defaults, explicit.
    assert annotations_of(tools["crashes"]) == {
        "readOnlyHint": False,
        "destructiveHint": True,
        "idempotentHint": False,
        "openWorldHint": True,
    }
    assert annotations_of(tools["get_thing"])["readOnlyHint"] is True
    assert kit.missing_hints() == {"plain_set": ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]}


def test_an_exception_in_a_write_tool_is_an_unknown_outcome_naming_the_read():
    server, _, seen = make()
    r = run(call(server, "crashes", {"id": "t-1"}))
    assert seen["crashed"] == "t-1"
    assert r.is_error
    assert r.shape["outcome"] == "unknown" and r.shape["repeat"] == "read_first"
    assert r.shape["read_with"] == {"tool": "get_thing", "arguments": {"id": "t-1"}}
    assert r.shape["code"] == "internal_error"
    assert "SECRET" not in r.text and "Cause: KeyError" in r.text


def test_output_schema_is_advertised_and_results_conform():
    import jsonschema

    server, _, _ = make()
    tools = {t.name: t.model_dump(by_alias=True, exclude_none=True) for t in run(server.list_tools())}
    schema = tools["strict_set"]["outputSchema"]
    assert schema["required"] == ["mws"] and schema["then"] == {"required": ["flag"]}
    assert "write_result" in schema["$defs"]
    assert tools["crashes"]["outputSchema"]["required"] == ["mws"]
    assert "outputSchema" not in tools["get_thing"]
    v = jsonschema.Draft202012Validator(schema)
    v.validate(run(call(server, "strict_set", {"flag": True})).structured)
    v.validate(run(call(server, "strict_set", {"flag": "x"})).structured)  # the refusal conforms too


def test_an_unsent_request_is_not_applied():
    server, _, _ = make()
    r = run(call(server, "never_sent", {"id": "t-1"}))
    assert r.is_error and r.shape["outcome"] == "not_applied" and r.shape["code"] == "not_sent" and r.shape["repeat"] == "yes"


def test_read_tool_errors_are_left_to_the_sdk():
    server, _, _ = make()
    if SDK == 2:
        with pytest.raises(Exception):
            run(server.call_tool("read_crashes", {}))
    else:
        with pytest.raises(Exception):
            run(server.call_tool("read_crashes", {}))


def test_attach_twice_and_unsupported_objects():
    server, _, _ = make()
    with pytest.raises(k.IntegrationError):
        k.WriteSafety(server)
    with pytest.raises(k.IntegrationError):
        k.WriteSafety(object())


def test_duplicate_tool_name_refused():
    server, kit, _ = make()
    with pytest.raises(k.IntegrationError):
        kit.read_tool(name="get_thing")(lambda id: None)


def test_lax_mode_is_available_but_not_default():
    server = FastMCP("t")
    kit = k.WriteSafety(server, strict=False)
    seen = {}

    @kit.write_tool(read_tool="x")
    def lax(flag: bool) -> CallToolResult:
        seen["v"] = flag
        return k.applied("ok")

    r = run(call(server, "lax", {"flag": "true"}))
    assert not r.is_error and seen["v"] is True


def test_explicit_input_schema():
    server = FastMCP("t")
    kit = k.WriteSafety(server)

    @kit.write_tool(
        read_tool="x",
        input_schema={"type": "object", "properties": {"n": {"type": "integer", "maximum": 3}}, "required": ["n"]},
    )
    def capped(n: int) -> CallToolResult:
        return k.applied("ok")

    r = run(call(server, "capped", {"n": 4}))
    assert r.is_error and 'Argument "n": must be at most 3' in r.text and r.shape["argument"] == "/n"
    tools = {t.name: t for t in run(server.list_tools())}
    assert schema_of(tools["capped"])["properties"]["n"]["maximum"] == 3


def test_annotation_helpers_and_lint():
    w = k.write().model_dump(by_alias=True, exclude_none=True)
    assert w == {"readOnlyHint": False, "destructiveHint": True, "idempotentHint": False, "openWorldHint": True}
    r = k.read_only(open_world=False).model_dump(by_alias=True, exclude_none=True)
    assert r == {"readOnlyHint": True, "destructiveHint": False, "idempotentHint": True, "openWorldHint": False}
    tools = [
        {"name": "a", "annotations": {"readOnlyHint": True, "destructiveHint": False, "idempotentHint": True, "openWorldHint": True}},
        {"name": "b", "annotations": {"readOnlyHint": False}},
        {"name": "c"},
    ]
    assert k.missing_hints(tools) == {
        "b": ["destructiveHint", "idempotentHint", "openWorldHint"],
        "c": ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"],
    }
