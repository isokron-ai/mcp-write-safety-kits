"""The README's quick start and its fallback run as written (with the SDK 1.x import where 2.x is
not installed)."""

from __future__ import annotations

import re
from pathlib import Path

from conftest import call, run


def _blocks() -> list[str]:
    readme = (Path(__file__).resolve().parent.parent / "README.md").read_text(encoding="utf-8")
    code = re.findall(r"```python\n(.*?)```", readme, re.S)
    try:
        import mcp.server.mcpserver  # noqa: F401
    except ImportError:
        code[0] = code[0].replace("from mcp.server.mcpserver import MCPServer", "from mcp.server.fastmcp import FastMCP as MCPServer")
    return code


def _racing(ns: dict) -> None:
    """Another writer changes the note once, between the guard's read and its write."""
    plain, raced = ns["read"], []

    def read(note_id):
        snap = plain(note_id)
        if not raced:
            raced.append(True)
            ns["db"].execute("UPDATE notes SET title = 'Theirs', version = version + 1 WHERE id = ?", (note_id,))
        return snap

    ns["guard"].read = read


def test_quick_start():
    ns: dict = {}
    exec(compile(_blocks()[0], "README quick start", "exec"), ns)
    server = ns["server"]
    ok = run(call(server, "rename_note", {"id": "n-1", "expected_version": 1, "title": "Plan"}))
    assert ok.shape["outcome"] == "applied" and ok.shape["changed"] == ["/title"]
    stale = run(call(server, "rename_note", {"id": "n-1", "expected_version": 1, "title": "Other"}))
    assert stale.is_error and stale.shape["code"] == "conflict"
    assert stale.shape["conflict"]["checked_by"] == "backend" and stale.shape["conflict"]["current_version"] == 2
    bad = run(call(server, "rename_note", {"id": "n-1", "expected_version": 2, "title": 5}))
    assert bad.is_error and bad.shape["code"] == "invalid_argument"
    assert ns["read"]("n-1").state["title"] == "Plan"


def test_quick_start_refuses_a_write_that_lands_after_the_read():
    ns: dict = {}
    exec(compile(_blocks()[0], "README quick start", "exec"), ns)
    _racing(ns)
    lost = run(call(ns["server"], "rename_note", {"id": "n-1", "expected_version": 1, "title": "Mine"}))
    assert lost.is_error and lost.shape["code"] == "conflict" and lost.shape["repeat"] == "read_first"
    assert lost.shape["conflict"]["checked_by"] == "backend"
    assert lost.shape["conflict"]["current_state"] == {"id": "n-1", "title": "Theirs", "version": 2}
    assert ns["read"]("n-1").state["title"] == "Theirs"  # the other writer's change is kept


def test_fallback_compares_in_the_server_and_loses_a_writer_outside_it():
    code = _blocks()
    ns: dict = {}
    exec(compile(code[0], "README quick start", "exec"), ns)
    exec(compile(code[1], "README fallback", "exec"), ns)  # replaces write and guard
    server = ns["server"]
    ok = run(call(server, "rename_note", {"id": "n-1", "expected_version": 1, "title": "Plan"}))
    assert ok.shape["outcome"] == "applied"
    stale = run(call(server, "rename_note", {"id": "n-1", "expected_version": 1, "title": "Other"}))
    assert stale.is_error and stale.shape["conflict"]["checked_by"] == "server"
    # The race the README states: a change that lands between the comparison and the write is lost.
    _racing(ns)
    over = run(call(server, "rename_note", {"id": "n-1", "expected_version": 2, "title": "Mine"}))
    assert over.shape["outcome"] == "applied"
    assert ns["read"]("n-1").state["title"] == "Mine"
