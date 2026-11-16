"""notes_server: a small MCP server for notes, built only with mcp-write-safety-kit.

One kind of object (a note: id, title, body, tags, version), list fields (tags), and a bulk delete.
The store is in memory; a restart empties it.

Run it::

    python server.py              # streamable HTTP on a free loopback port; the first stdout line is
                                  # {"mcp": "http://127.0.0.1:<port>/mcp"}
    python server.py --stdio      # stdio

Works with the MCP Python SDK 2.x (``MCPServer``) and 1.x (``FastMCP``).
"""

from __future__ import annotations

import argparse
import json
import socket
import sys
from typing import Annotated, Any

from mcp.types import CallToolResult, TextContent
from pydantic import Field
from store import NoteStore

from mws_kit import (
    Idempotency,
    VersionGuard,
    WriteSafety,
    applied,
    item,
    not_applied,
    partial,
    pointer,
    q,
    read_answer,
    read_with,
)

try:  # MCP Python SDK 2.x
    from mcp.server.mcpserver import MCPServer as FastMCP
except ImportError:  # 1.x
    from mcp.server.fastmcp import FastMCP  # type: ignore[no-redef]

Id = Annotated[str, Field(min_length=1, max_length=40, description="A note id, such as n-3.")]
Version = Annotated[str, Field(min_length=1, max_length=20, pattern=r"^[0-9]+$", description="The version you read, as get_note returns it.")]
Title = Annotated[str, Field(min_length=1, max_length=200)]
Body = Annotated[str, Field(max_length=10_000)]
Tag = Annotated[str, Field(min_length=1, max_length=40, pattern=r"^[a-z0-9][a-z0-9-]*$")]
Tags = Annotated[list[Tag], Field(max_length=20)]
Key = Annotated[str, Field(min_length=8, max_length=200)]

INSTRUCTIONS = (
    "Notes with titles, bodies and tags. Every note has a version that changes whenever the note changes. "
    "Writes that change or delete a note need the version you read (expected_version): if the note changed "
    "since, nothing is written and the answer carries the current state and version. Every write answers "
    "with structuredContent.mws, the write-result shape 0.1 (MWS 0.9 draft Annex B-9)."
)

#: The schema of a note, as get_note returns it: the tool's own output beside mws on create and update.
NOTE_SCHEMA = {
    "type": "object",
    "properties": {
        "id": {"type": "string"},
        "title": {"type": "string"},
        "body": {"type": "string"},
        "tags": {"type": "array", "items": {"type": "string"}},
        "version": {"type": "string"},
    },
    "required": ["id", "title", "body", "tags", "version"],
}
NOTE_OUTPUT = {"type": "object", "properties": {"note": NOTE_SCHEMA}, "required": ["note"]}


def build(store: NoteStore | None = None) -> tuple[Any, NoteStore]:
    """The server and its store (tests build one per test)."""
    store = store or NoteStore()
    server = FastMCP("notes", instructions=INSTRUCTIONS)
    kit = WriteSafety(server)
    keys = Idempotency(ttl=24 * 3600)
    # state_fields: what a conflict may show of a note (every field get_note returns; none is secret).
    guard = dict(read=store.snapshot, read_tool="get_note", noun="note", object_type="note",
                 state_fields=("id", "title", "body", "tags", "version"))
    notes = VersionGuard(write=store.patch, data_key="note", **guard)
    deletes = VersionGuard(write=store.delete, **guard)

    def missing(note_id: str) -> CallToolResult:
        return CallToolResult(
            content=[TextContent(type="text", text=f"Note {q(note_id)} does not exist.")],
            structuredContent={"found": False, "id": note_id},
            isError=True,
        )

    def not_found(note_id: str, operation: str) -> CallToolResult:
        return not_applied(
            f"note {q(note_id)} does not exist",
            code="not_found",
            message=f"no note has the id {q(note_id)}",
            object={"type": "note", "id": note_id},
            operation=operation,
        )

    # -- reads ----------------------------------------------------------------------------------

    @kit.read_tool(open_world=False, description="List notes, optionally only those whose title starts with title_prefix or that carry tag.")
    def list_notes(title_prefix: Annotated[str, Field(max_length=200)] | None = None, tag: Tag | None = None) -> CallToolResult:
        found = store.list(title_prefix=title_prefix, tag=tag)
        return read_answer({"notes": found, "count": len(found)})

    @kit.read_tool(open_world=False, description="Read one note by id, with its version.")
    def get_note(id: Id) -> CallToolResult:  # noqa: A002
        n = store.get(id)
        return read_answer(n) if n is not None else missing(id)

    # -- writes ---------------------------------------------------------------------------------

    @kit.write_tool(
        read_tool="list_notes",
        destructive=False,
        idempotent=False,
        open_world=False,
        output=NOTE_OUTPUT,
        description="Create a note. Returns it, with its id and version. " + keys.describe(),
    )
    def create_note(title: Title, body: Body = "", tags: Tags | None = None, idempotency_key: Key | None = None) -> CallToolResult:
        args = {"title": title, "body": body, "tags": tags or []}

        def write() -> CallToolResult:
            n = store.create(title=title, body=body, tags=tags or [])
            return applied(
                f"created note {q(n['id'])}",
                operation="create",
                object={"type": "note", "id": n["id"], "version": n["version"]},
                changed=[pointer(f) for f in ("title", "body", "tags") if args[f] not in ("", [])],
                data={"note": n},
            )

        return keys.run(
            scope="create_note",
            key=idempotency_key,
            arguments=args,
            write=write,
            read_with=read_with("list_notes", title_prefix=title),
        )

    @kit.write_tool(
        read_tool="get_note",
        read_arguments={"id": "id"},
        destructive=True,
        idempotent=True,
        open_world=False,
        output=NOTE_OUTPUT,
        description=(
            "Change some fields of a note; fields you do not send keep their values. expected_version is the "
            "version you read: if the note changed since, nothing is written and the answer carries the current "
            "state and version. A field sent as null is treated as not sent."
        ),
    )
    def update_note(
        id: Id,  # noqa: A002
        expected_version: Version,
        title: Title | None = None,
        body: Body | None = None,
        tags: Tags | None = None,
    ) -> CallToolResult:
        change = {k: v for k, v in (("title", title), ("body", body), ("tags", tags)) if v is not None}
        if not change:
            return not_applied(
                f"no field to change was sent for note {q(id)}",
                code="invalid_argument",
                message='send at least one of "title", "body" or "tags"',
                argument="",
                object={"type": "note", "id": id},
                operation="update",
            )
        return notes.apply(id, expected_version, change)

    @kit.write_tool(
        read_tool="get_note",
        read_arguments={"id": "id"},
        destructive=True,
        idempotent=True,
        open_world=False,
        description="Delete a note. expected_version is the version you read: if the note changed since, nothing is deleted.",
    )
    def delete_note(id: Id, expected_version: Version) -> CallToolResult:  # noqa: A002
        return deletes.delete(id, expected_version)

    @kit.write_tool(
        read_tool="get_note",
        read_arguments={"id": "id"},
        destructive=False,
        idempotent=True,
        open_world=False,
        output=NOTE_OUTPUT,
        description="Add one tag to a note. Other tags are kept; adding a tag the note already has changes nothing.",
    )
    def add_tag(id: Id, tag: Tag) -> CallToolResult:  # noqa: A002
        if store.get(id) is None:
            return not_found(id, "add_tag")
        n, changed = store.add_tag(id, tag)
        return applied(
            f"added tag {q(tag)} to note {q(id)}" if changed else f"note {q(id)} already has tag {q(tag)}",
            operation="add_tag",
            object={"type": "note", "id": id, "version": n["version"]},
            changed=["/tags"] if changed else [],
            data={"note": n},
        )

    @kit.write_tool(
        read_tool="get_note",
        read_arguments={"id": "id"},
        destructive=True,
        idempotent=True,
        open_world=False,
        output=NOTE_OUTPUT,
        description="Remove one tag from a note, named by its value. Other tags are kept.",
    )
    def remove_tag(id: Id, tag: Tag) -> CallToolResult:  # noqa: A002
        if store.get(id) is None:
            return not_found(id, "remove_tag")
        n, changed = store.remove_tag(id, tag)
        return applied(
            f"removed tag {q(tag)} from note {q(id)}" if changed else f"note {q(id)} has no tag {q(tag)}",
            operation="remove_tag",
            object={"type": "note", "id": id, "version": n["version"]},
            changed=["/tags"] if changed else [],
            data={"note": n},
        )

    @kit.write_tool(
        read_tool="list_notes",
        destructive=True,
        idempotent=True,
        open_world=False,
        description=(
            "Delete several notes by id, all or nothing: if any note is missing or changed, none is deleted and "
            "each is listed with the reason. Send expected_versions (one per id, in the same order) to refuse "
            "notes that changed since you read them; to delete without that check, set force to true."
        ),
    )
    def delete_notes(
        ids: Annotated[list[Id], Field(min_length=1, max_length=50, json_schema_extra={"uniqueItems": True})],
        expected_versions: Annotated[list[Version], Field(min_length=1, max_length=50)] | None = None,
        force: bool = False,
    ) -> CallToolResult:
        if expected_versions is None and not force:
            return not_applied(
                "expected_versions is required to delete notes",
                code="version_required",
                message="the call carried neither expected_versions nor force",
                argument="/expected_versions",
                operation="delete",
                notes=["Read each note and send its version in expected_versions, in the order of ids"],
            )
        if expected_versions is not None and len(expected_versions) != len(ids):
            return not_applied(
                f"expected_versions has {len(expected_versions)} items and ids has {len(ids)}",
                code="invalid_argument",
                message="send one version per id, in the same order",
                argument="/expected_versions",
                operation="delete",
            )
        deleted, failures = store.delete_many(ids, expected_versions)
        if failures:
            bad = dict(failures)
            return partial(
                f"deleted none of the {len(ids)} notes",
                operation="delete",
                items=[
                    item(i, "not_applied", id=nid, code="conflict" if "changed" in bad[nid] else "not_found", message=bad[nid])
                    if nid in bad
                    else item(i, "not_attempted", id=nid, message="the delete is all or nothing")
                    for i, nid in enumerate(ids)
                ],
                read_with=read_with("list_notes"),
            )
        return applied(
            f"deleted {len(deleted)} notes",
            operation="delete",
            items=[item(i, "applied", id=n["id"], version=n["version"]) for i, n in enumerate(deleted)],
        )

    return server, store


def _serve_http(server: Any) -> None:
    import uvicorn

    app = server.streamable_http_app()
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(("127.0.0.1", 0))
    sock.listen(128)
    port = sock.getsockname()[1]
    print(json.dumps({"mcp": f"http://127.0.0.1:{port}/mcp"}), flush=True)
    config = uvicorn.Config(app, log_level="warning", lifespan="on")
    uvicorn.Server(config).run(sockets=[sock])


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--stdio", action="store_true", help="serve over stdio instead of streamable HTTP")
    a = p.parse_args(argv)
    server, _ = build()
    if a.stdio:
        server.run()
    else:
        _serve_http(server)


if __name__ == "__main__":
    sys.exit(main())
