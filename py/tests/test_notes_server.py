"""The example server end to end, through the SDK's call path."""

from __future__ import annotations


def create(notes, **args):
    r = notes("create_note", {"title": "t", **args})
    assert not r.is_error, r
    return r.shape["object"]


def test_create_returns_id_and_version(notes):
    o = create(notes, body="b", tags=["a"])
    assert o == {"type": "note", "id": "n-1", "version": "1"}
    r = notes("get_note", {"id": "n-1"})
    assert r.structured == {"id": "n-1", "title": "t", "body": "b", "tags": ["a"], "version": "1"}


def test_create_with_key_is_applied_once(notes):
    a = notes("create_note", {"title": "t", "idempotency_key": "key-00001"})
    b = notes("create_note", {"title": "t", "idempotency_key": "key-00001"})
    c = notes("create_note", {"title": "u", "idempotency_key": "key-00001"})
    assert b.shape == {**a.shape, "replayed": True} and "repeats an earlier call" in b.text
    assert b.structured["note"] == a.structured["note"]
    assert c.is_error and c.shape["code"] == "idempotency_key_reused"
    assert len(notes.store.list()) == 1


def test_update_is_a_field_patch_with_a_receipt(notes):
    create(notes, body="keep", tags=["a", "b"])
    r = notes("update_note", {"id": "n-1", "expected_version": "1", "title": "new"})
    assert r.shape == {
        "shape": "write-result/0.1",
        "outcome": "applied",
        "repeat": "no",
        "operation": "update",
        "object": {"type": "note", "id": "n-1", "version": "2"},
        "changed": ["/title"],
    }
    stored = {"id": "n-1", "title": "new", "body": "keep", "tags": ["a", "b"], "version": "2"}
    assert notes.store.get("n-1") == stored
    assert r.structured["note"] == stored  # the tool's own output beside mws


def test_stale_update_is_a_conflict_with_current_state(notes):
    create(notes)
    notes("update_note", {"id": "n-1", "expected_version": "1", "body": "other writer"})
    r = notes("update_note", {"id": "n-1", "expected_version": "1", "title": "mine"})
    assert r.is_error
    assert r.shape["code"] == "conflict" and r.shape["repeat"] == "read_first"
    assert r.shape["conflict"] == {
        "current_version": "2",
        "version_source": "backend",
        "current_state": {"id": "n-1", "title": "t", "body": "other writer", "tags": [], "version": "2"},
    }
    assert "note" not in r.structured
    assert notes.store.get("n-1")["title"] == "t"


def test_update_needs_the_version_and_a_field(notes):
    create(notes)
    r = notes("update_note", {"id": "n-1", "title": "x"})
    assert r.is_error and 'Argument "expected_version": is required and was not sent' in r.text
    assert r.shape["argument"] == "/expected_version"
    r = notes("update_note", {"id": "n-1", "expected_version": "1"})
    assert r.is_error and "no field to change was sent" in r.text
    r = notes("update_note", {"id": "n-1", "expected_version": 1, "title": "x"})
    assert r.is_error and 'expected string, got number 1' in r.text


def test_update_missing_note(notes):
    r = notes("update_note", {"id": "n-9", "expected_version": "1", "body": "x"})
    assert r.is_error and r.shape["outcome"] == "not_applied" and r.shape["code"] == "not_found"


def test_stale_delete_is_refused(notes):
    create(notes)
    notes("add_tag", {"id": "n-1", "tag": "x"})
    r = notes("delete_note", {"id": "n-1", "expected_version": "1"})
    assert r.is_error and r.shape["conflict"]["current_version"] == "2"
    assert notes.store.get("n-1") is not None
    r = notes("delete_note", {"id": "n-1", "expected_version": "2"})
    assert not r.is_error and notes.store.get("n-1") is None


def test_tags_are_addressed_by_value(notes):
    """MWS-UPD-2: the address of an element does not shift when the list changes."""
    create(notes, tags=["a", "b", "c"])
    notes("update_note", {"id": "n-1", "expected_version": "1", "tags": ["z", "a", "b", "c"]})  # another writer inserts
    r = notes("remove_tag", {"id": "n-1", "tag": "b"})
    assert r.shape["changed"] == ["/tags"]
    assert notes.store.get("n-1")["tags"] == ["z", "a", "c"]


def test_add_tag_is_additive_and_idempotent(notes):
    create(notes, tags=["a"])
    r1 = notes("add_tag", {"id": "n-1", "tag": "b"})
    r2 = notes("add_tag", {"id": "n-1", "tag": "b"})
    assert r1.shape["changed"] == ["/tags"] and r2.shape["changed"] == []
    assert r2.shape["object"]["version"] == r1.shape["object"]["version"]
    assert notes.store.get("n-1")["tags"] == ["a", "b"]


def test_bulk_delete_is_all_or_nothing_and_names_every_item(notes):
    """MWS-ATOM-1 and ATOM-2, with the refused item first, in the middle and last."""
    for pos in range(3):
        ids = [create(notes)["id"], create(notes)["id"]]
        batch = ids[:pos] + ["n-999"] + ids[pos:]
        r = notes("delete_notes", {"ids": batch, "force": True})
        assert r.is_error and r.shape["outcome"] == "not_applied"
        items = r.shape["items"]
        assert [i["index"] for i in items] == list(range(3)) and [i["id"] for i in items] == batch
        by = {i["id"]: i for i in items}
        assert by["n-999"]["outcome"] == "not_applied" and by["n-999"]["code"] == "not_found"
        assert all(by[i]["outcome"] == "not_attempted" for i in ids)
        assert all(notes.store.get(i) is not None for i in ids)
    ids = [n["id"] for n in notes.store.list()]
    r = notes("delete_notes", {"ids": ids, "force": True})
    assert not r.is_error and [a["id"] for a in r.shape["items"]] == ids
    assert {a["outcome"] for a in r.shape["items"]} == {"applied"}
    assert notes.store.list() == []


def test_bulk_delete_checks_versions_unless_forced(notes):
    a, b = create(notes)["id"], create(notes)["id"]
    r = notes("delete_notes", {"ids": [a, b]})
    assert r.is_error and r.shape["code"] == "version_required"
    notes("add_tag", {"id": b, "tag": "x"})
    r = notes("delete_notes", {"ids": [a, b], "expected_versions": ["1", "1"]})
    assert r.is_error
    assert [(i["outcome"], i.get("code")) for i in r.shape["items"]] == [("not_attempted", None), ("not_applied", "conflict")]
    r = notes("delete_notes", {"ids": [a, b], "expected_versions": ["1", "2"]})
    assert not r.is_error and notes.store.list() == []


def test_bulk_delete_input_constraints(notes):
    r = notes("delete_notes", {"ids": [], "force": True})
    assert r.is_error and 'Argument "ids": must have at least 1 items' in r.text
    r = notes("delete_notes", {"ids": ["n-1", "n-1"], "force": True})
    assert r.is_error and "must not repeat an item" in r.text
    r = notes("delete_notes", {"ids": ["n-1"], "force": "true"})
    assert r.is_error and 'Argument "force": expected boolean, got string "true"' in r.text


def test_list_and_missing(notes):
    create(notes, tags=["x"])
    create(notes, title="other")
    assert notes("list_notes", {"tag": "x"}).structured["count"] == 1
    assert notes("list_notes", {"title_prefix": "oth"}).structured["count"] == 1
    r = notes("get_note", {"id": "n-9"})
    assert r.is_error and r.structured == {"found": False, "id": "n-9"}


def test_every_write_result_conforms_to_the_advertised_output_schema(notes):
    import jsonschema

    from conftest import run

    tools = {t.name: t.model_dump(by_alias=True, exclude_none=True) for t in run(notes.server.list_tools())}
    calls = [
        ("create_note", {"title": "t", "tags": ["a"]}),
        ("update_note", {"id": "n-1", "expected_version": "1", "body": "b"}),
        ("update_note", {"id": "n-1", "expected_version": "1", "body": "c"}),
        ("update_note", {"id": "n-1", "expected_version": 1, "body": "c"}),
        ("add_tag", {"id": "n-1", "tag": "z"}),
        ("remove_tag", {"id": "n-9", "tag": "z"}),
        ("delete_notes", {"ids": ["n-1", "n-9"], "force": True}),
        ("delete_note", {"id": "n-1", "expected_version": "3"}),
    ]
    for name, args in calls:
        r = notes(name, args)
        jsonschema.Draft202012Validator(tools[name]["outputSchema"]).validate(r.structured)


def test_the_sdk_client_accepts_every_result_against_the_output_schema():
    """The SDK's own client validates structuredContent against the advertised outputSchema."""
    from conftest import run
    from server import build

    server, _ = build()

    async def go(c):
        r1 = await c.call_tool("create_note", {"title": "a"})
        r2 = await c.call_tool("update_note", {"id": "n-1", "expected_version": "9", "body": "x"})
        r3 = await c.call_tool("delete_notes", {"ids": ["n-1", "n-9"], "force": True})
        return r1, r2, r3

    async def main():
        try:
            from mcp import Client  # SDK 2.x

            async with Client(server) as c:
                return await go(c)
        except ImportError:  # SDK 1.x
            from mcp.shared.memory import create_connected_server_and_client_session

            async with create_connected_server_and_client_session(server._mcp_server) as c:
                return await go(c)

    r1, r2, r3 = run(main())
    sc = [getattr(r, "structured_content", None) or getattr(r, "structuredContent", None) for r in (r1, r2, r3)]
    assert [s["mws"]["outcome"] for s in sc] == ["applied", "not_applied", "not_applied"]
    assert sc[1]["mws"]["code"] == "conflict"
