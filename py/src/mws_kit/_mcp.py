"""The few MCP SDK types the kit uses, imported in one place.

The kit supports the official MCP Python SDK 1.x (``mcp.server.fastmcp.FastMCP``) and 2.x
(``mcp.server.mcpserver.MCPServer``). Both expose these types from ``mcp.types``, and both accept
camelCase field names (``structuredContent``, ``isError``) when a result is built.
"""

from __future__ import annotations

from mcp.types import CallToolResult, TextContent, ToolAnnotations

__all__ = ["CallToolResult", "TextContent", "ToolAnnotations", "structured_of", "is_error_of", "text_of"]


def structured_of(result: CallToolResult) -> dict | None:
    """The result's ``structuredContent`` under either SDK's attribute name."""
    for name in ("structured_content", "structuredContent"):
        value = getattr(result, name, None)
        if value is not None:
            return value
    return None


def is_error_of(result: CallToolResult) -> bool:
    """The result's ``isError`` under either SDK's attribute name."""
    for name in ("is_error", "isError"):
        value = getattr(result, name, None)
        if value is not None:
            return bool(value)
    return False


def text_of(result: CallToolResult) -> str:
    """The text of the result's text blocks, joined by new lines."""
    return "\n".join(getattr(b, "text", "") for b in result.content if getattr(b, "type", None) == "text")
