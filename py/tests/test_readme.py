"""The README's quick start runs as written (with the SDK 1.x import where 2.x is not installed)."""

from __future__ import annotations

import re
from pathlib import Path

from conftest import call, run


def test_quick_start():
    readme = (Path(__file__).resolve().parent.parent / "README.md").read_text(encoding="utf-8")
    code = re.findall(r"```python\n(.*?)```", readme, re.S)[0]
    try:
        import mcp.server.mcpserver  # noqa: F401
    except ImportError:
        code = code.replace("from mcp.server.mcpserver import MCPServer", "from mcp.server.fastmcp import FastMCP as MCPServer")
    ns: dict = {}
    exec(compile(code, "README quick start", "exec"), ns)
    server = ns["server"]
    ok = run(call(server, "rename_note", {"id": "n-1", "expected_version": 1, "title": "Plan"}))
    assert ok.shape["outcome"] == "applied" and ok.shape["changed"] == ["/title"]
    stale = run(call(server, "rename_note", {"id": "n-1", "expected_version": 1, "title": "Other"}))
    assert stale.is_error and stale.shape["code"] == "conflict"
    bad = run(call(server, "rename_note", {"id": "n-1", "expected_version": 2, "title": 5}))
    assert bad.is_error and bad.shape["code"] == "invalid_argument"
