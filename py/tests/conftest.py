from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path
from typing import Any

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "examples" / "notes_server"))

from mws_kit._mcp import is_error_of, structured_of, text_of  # noqa: E402


def run(coro: Any) -> Any:
    return asyncio.run(coro)


class Called:
    """A tool answer in one form, whichever SDK line produced it."""

    def __init__(self, raw: Any) -> None:
        self.raw = raw
        if hasattr(raw, "content"):
            self.text = raw.content[0].text if raw.content else ""
            self.structured = structured_of(raw)
            self.is_error = is_error_of(raw)
        elif isinstance(raw, tuple):  # SDK 1.x: (content blocks, structured)
            blocks, self.structured = raw
            self.text = "\n".join(b.text for b in blocks)
            self.is_error = False
        else:  # SDK 1.x: content blocks only
            self.text = "\n".join(b.text for b in raw)
            self.structured = None
            self.is_error = False

    @property
    def shape(self) -> dict[str, Any]:
        assert isinstance(self.structured, dict), self.text
        m = self.structured.get("mws")
        assert isinstance(m, dict) and m.get("shape") == "write-result/0.1", self.text
        return m

    def __repr__(self) -> str:
        return f"Called(is_error={self.is_error}, text={self.text!r}, structured={json.dumps(self.structured)})"


async def call(server: Any, name: str, args: dict[str, Any]) -> Called:
    """A call through a real client session, so that it passes the server's whole call path
    (SDK 2.x middleware included). The SDK's client validates structuredContent against the
    tool's outputSchema."""
    try:
        from mcp import Client  # SDK 2.x

        async with Client(server) as c:
            return Called(await c.call_tool(name, args))
    except ImportError:  # SDK 1.x
        from mcp.shared.memory import create_connected_server_and_client_session

        async with create_connected_server_and_client_session(server._mcp_server) as c:
            return Called(await c.call_tool(name, args))


@pytest.fixture
def notes():
    from server import build

    server, store = build()

    def c(name: str, args: dict[str, Any]) -> Called:
        return run(call(server, name, args))

    c.server = server  # type: ignore[attr-defined]
    c.store = store  # type: ignore[attr-defined]
    return c
