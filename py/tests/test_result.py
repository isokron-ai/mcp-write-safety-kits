"""The write-result shape 0.1 (Annex B, B-9) and its text (MWS-RES-1, RES-2, RES-4, ATOM-1, CONC-4,
CONC-6)."""

from __future__ import annotations

import json

import jsonschema  # a dependency of the MCP SDK; used here only to check the shipped schema
import pytest

import mws_kit as k
from mws_kit._mcp import is_error_of, structured_of


def mws(r):
    return structured_of(r)["mws"]


def texts(r):
    return [b.text for b in r.content]


def test_applied_receipt():
    r = k.applied(
        'updated note "n-3"',
        operation="update",
        object={"type": "note", "id": "n-3", "version": 4},
        changed=["/title", "/tags"],
        data={"note": {"id": "n-3"}},
    )
    assert structured_of(r) == {
        "note": {"id": "n-3"},
        "mws": {
            "shape": "write-result/0.1",
            "outcome": "applied",
            "repeat": "no",
            "operation": "update",
            "object": {"type": "note", "id": "n-3", "version": 4},  # ids and versions keep their JSON type
            "changed": ["/title", "/tags"],
        },
    }
    assert not is_error_of(r)
    first, second = texts(r)
    assert first.startswith('Applied: updated note "n-3".')
    assert 'Changed: "/title", "/tags".' in first
    assert json.loads(second) == structured_of(r)  # the second block is the serialized structuredContent


@pytest.mark.parametrize(
    "result, outcome, is_error, opening",
    [
        (lambda: k.applied("x"), "applied", False, "Applied: x."),
        (lambda: k.accepted("x"), "accepted", False, "Accepted: x. The backend has not yet reported the result."),
        (lambda: k.not_applied("x"), "not_applied", True, "Not applied: x. Nothing was changed."),
        (
            lambda: k.partial("x", items=[k.item(0, "applied", id="a"), k.item(1, "not_applied", id="b", code="not_found")], read_with=k.read_with("list")),
            "partial",
            True,
            "Partly applied: x.",
        ),
        (
            lambda: k.unknown_outcome("x", read_with=k.read_with("get", id="a")),
            "unknown",
            True,
            "Outcome unknown: x. It is not known whether the change was applied.",
        ),
    ],
)
def test_outcome_iserror_and_opening_words(result, outcome, is_error, opening):
    r = result()
    assert mws(r)["outcome"] == outcome
    assert is_error_of(r) is is_error
    assert texts(r)[0].startswith(opening)


def test_members_not_relevant_are_left_out():
    r = k.not_applied("no such note")
    assert mws(r) == {"shape": "write-result/0.1", "outcome": "not_applied", "repeat": "no"}


def test_changed_empty_and_missing_differ():
    assert mws(k.applied("x", changed=[]))["changed"] == []
    assert "changed" not in mws(k.applied("x"))
    assert "Changed: nothing." in texts(k.applied("x", changed=[]))[0]


def test_not_applied_never_carries_a_version_in_object():
    r = k.not_applied("x", object={"id": "a", "version": 3})
    assert mws(r)["object"] == {"id": "a"}


def test_partial_names_every_item_and_falls_back_to_not_applied():
    r = k.partial(
        "deleted 1 of 3 notes",
        items=[
            k.item(0, "applied", id="n-1", version="2"),
            k.item(1, "not_applied", id="n-2", code="not_found", message="does not exist"),
            k.item(2, "not_attempted", id="n-3"),
        ],
        read_with=k.read_with("list_notes"),
    )
    m = mws(r)
    assert m["outcome"] == "partial" and m["repeat"] == "read_first"
    t = texts(r)[0]
    assert "Some items remain applied; the JSON below gives the outcome of each." in t
    r = k.partial("none", items=[k.item(0, "not_applied", id="a"), k.item(1, "not_attempted", id="b")])
    assert mws(r)["outcome"] == "not_applied"


def test_conflict_carries_state_and_version_unambiguously():
    r = k.conflict(
        "n-3",
        current_version=5,
        checked_by="backend",
        current_state={"id": "n-3", "title": "v2 draft", "version": 5},
        omitted=["/body"],
        read_tool="get_note",
        noun="note",
        object_type="note",
    )
    m = mws(r)
    assert is_error_of(r)
    assert m == {
        "shape": "write-result/0.1",
        "outcome": "not_applied",
        "repeat": "read_first",
        "object": {"type": "note", "id": "n-3"},
        "code": "conflict",
        "message": 'note "n-3" changed since the version you read',
        "conflict": {
            "current_version": 5,
            "checked_by": "backend",
            "current_state": {"id": "n-3", "title": "v2 draft", "version": 5},
            "omitted": ["/body"],
        },
        "read_with": {"tool": "get_note", "arguments": {"id": "n-3"}},
        "version_argument": "expected_version",
    }
    t = texts(r)[0]
    assert "Nothing was changed." in t
    # The state is not restated in prose (B-9, Text); it is in the JSON block.
    assert "Its current state and version are in the JSON below." in t
    assert "v2 draft" not in t
    assert json.loads(texts(r)[1])["mws"]["conflict"]["current_state"]["title"] == "v2 draft"
    # Something is omitted, so the read comes first (B-9, Repeat: read_first).
    assert 'Before writing again, read it with "get_note" and the arguments {"id":"n-3"}' in t


def test_conflict_without_a_version_leaves_it_out():
    m = mws(k.conflict("a", current_state={"t": 1}, read_tool="get"))
    assert "current_version" not in m["conflict"] and "version_argument" not in m


def test_lock():
    m = mws(k.conflict("a", code="locked", current_state=None, held_by="user ann", read_tool="get"))
    assert m["code"] == "locked" and m["conflict"] == {"held_by": "user ann"}


@pytest.mark.parametrize(
    "bad, message",
    [
        ({"outcome": "done"}, "is not one of"),
        ({"outcome": "unknown", "repeat": "yes"}, "retry-invited"),
        ({"outcome": "partial", "repeat": "yes", "items": []}, "retry-invited"),
        ({"outcome": "applied", "repeat": "maybe"}, "mws.repeat"),
        ({"outcome": "applied", "code": "Bad Code"}, "lowercase"),
        ({"outcome": "applied", "object": {"id": True}}, "string or an integer"),
        ({"outcome": "applied", "object": {"id": 2**60}}, r"within 2\^53-1"),
        ({"outcome": "applied", "repeat": "yes"}, "goes only with not_applied"),
        ({"outcome": "not_applied", "repeat": "same_key"}, "does not go with not_applied"),
        ({"outcome": "applied", "code": "no_answer"}, "goes with outcome"),
        ({"outcome": "not_applied", "code": "conflict", "repeat": "no", "read_with": {"tool": "g", "arguments": {}}}, "read_first"),
        ({"outcome": "not_applied", "code": "conflict", "repeat": "read_first"}, "read_with"),
        ({"outcome": "accepted", "changed": []}, "accepted gives no changed"),
        ({"outcome": "accepted", "object": {"version": 2}}, "accepted gives no object.version"),
        ({"outcome": "not_applied", "items": [{"outcome": "not_applied"}]}, "index, step or id"),
        ({"outcome": "not_applied", "argument_errors": [{"code": "x"}]}, "argument_errors"),
        ({"outcome": "not_applied", "object": {"id": "a", "version": "3"}}, "object.version is left out"),
        ({"outcome": "applied", "changed": ["title"]}, "JSON Pointers"),
        ({"outcome": "not_applied", "argument": "title"}, "JSON Pointer"),
        ({"outcome": "partial", "items": [{"index": 0, "outcome": "applied"}]}, "at least one item applied and one not"),
        ({"outcome": "partial", "items": [{"index": 0, "outcome": "applied"}, {"index": 1, "outcome": "unknown"}]}, "makes the whole outcome unknown"),
        ({"outcome": "not_applied", "conflict": {"current_version": "1", "current_state": {}}}, 'only where code is "conflict"'),
        ({"outcome": "applied", "replayed": False}, "replayed is true"),
        ({"outcome": "applied", "read_with": {"arguments": {}}}, "read_with"),
    ],
)
def test_shape_rules(bad, message):
    with pytest.raises(k.ShapeError, match=message):
        k.to_tool_result(bad, "x")


def test_none_member_is_left_out_not_null():
    r = k.to_tool_result({"outcome": "applied", "operation": None}, "x")
    assert "operation" not in mws(r)


def test_tool_output_may_not_use_mws():
    with pytest.raises(k.ShapeError):
        k.applied("x", data={"mws": 1})


def test_every_builder_output_matches_the_shipped_schema():
    for r in [
        k.applied("x", object={"id": "a", "version": 1}, changed=[], operation="create"),
        k.accepted("x"),
        k.not_applied("y", code="invalid_argument", argument="/title", message="m"),
        k.partial("z", items=[k.item(0, "applied", id="a"), k.item(1, "not_attempted")], applied_count=1, read_with=k.read_with("get")),
        k.conflict("a", current_version=3, current_state={}, read_tool="get"),
        k.unknown_outcome("w", read_with=k.read_with("get")),
        k.as_replay(k.applied("x")),
    ]:
        jsonschema.Draft202012Validator(k.WRITE_RESULT_SCHEMA).validate(mws(r))


def test_output_schema_requires_mws_always_and_own_members_only_on_applied():
    own = {"type": "object", "properties": {"note": {"type": "object"}}, "required": ["note"]}
    schema = k.output_schema(own)
    v = jsonschema.Draft202012Validator(schema)
    v.validate(structured_of(k.applied("x", data={"note": {}})))
    v.validate(structured_of(k.not_applied("x")))  # an error result without the tool's own output
    with pytest.raises(jsonschema.ValidationError):
        v.validate(structured_of(k.applied("x")))  # applied without "note"
    with pytest.raises(jsonschema.ValidationError):
        v.validate({"note": {}})  # no mws
    jsonschema.Draft202012Validator(k.output_schema()).validate(structured_of(k.not_applied("x")))
    with pytest.raises(ValueError):
        k.output_schema({"type": "array"})


def test_read_result_versions():
    from mcp.types import CallToolResult

    assert k.read_result(k.applied("x"))["outcome"] == "applied"
    # Before 1.0 a reader reads only the version it knows.
    assert k.read_result(CallToolResult(content=[], structuredContent={"mws": {"shape": "write-result/0.7", "outcome": "applied"}})) is None
    assert k.read_result(CallToolResult(content=[], structuredContent={"mws": {"shape": "write-result/1.0", "outcome": "applied"}})) is None
    assert k.read_result(k.read_answer({"id": "n-1"})) is None


def test_replay():
    first = k.applied('created note "n-1"', object={"id": "n-1", "version": 1}, changed=["/title"])
    again = k.as_replay(first)
    assert mws(again) == {**mws(first), "replayed": True, "repeat": "same_key"}
    assert k.REPLAY_NOTE in texts(again)[0]
    assert json.loads(texts(again)[1]) == structured_of(again)
    assert not is_error_of(again)
    assert is_error_of(k.as_replay(k.unknown_outcome("w", read_with=k.read_with("get"))))


def test_pointer_and_q():
    assert k.pointer("details", "a/b", "m~n") == "/details/a~1b/m~0n"
    assert k.pointer() == ""
    assert k.q({"a": [1, True, None]}) == '{"a":[1,true,null]}'


def test_shipped_schema_file_is_valid_2020_12():
    jsonschema.Draft202012Validator.check_schema(k.WRITE_RESULT_SCHEMA)
    assert k.WRITE_RESULT_SCHEMA["$defs"]["idv"]["type"] == ["string", "integer"]
    assert k.WRITE_RESULT_SCHEMA["properties"]["shape"] == {"const": "write-result/0.1"}

    def no_closed_objects(node):
        if isinstance(node, dict):
            assert node.get("additionalProperties") is not False
            for v in node.values():
                no_closed_objects(v)
        elif isinstance(node, list):
            for v in node:
                no_closed_objects(v)

    no_closed_objects(k.WRITE_RESULT_SCHEMA)
    assert k.WRITE_RESULT_SCHEMA["required"] == ["shape", "outcome"]



def test_ids_and_versions_keep_their_type_and_large_integers_become_strings():
    m = mws(k.applied("x", object={"id": 7, "version": 2**53}))
    assert m["object"] == {"id": 7, "version": str(2**53)}
    assert mws(k.applied("x", object={"id": "n-1", "version": "e1"}))["object"] == {"id": "n-1", "version": "e1"}


def test_repeat_after_applied_follows_the_guard_the_call_carried():
    assert mws(k.applied("x"))["repeat"] == "no"
    assert mws(k.applied("x", key=("idempotency_key", "k")))["repeat"] == "same_key"
    assert mws(k.applied("x", version=("expected_version", 3)))["repeat"] == "same_version"
    assert mws(k.accepted("x"))["repeat"] == "no"
    assert mws(k.accepted("x", key=("k", "v")))["repeat"] == "same_key"


def test_accepted_drops_version():
    assert "version" not in mws(k.accepted("x", object={"id": "j-1", "version": 3}))["object"]


def test_empty_selector_match_is_applied_with_zero():
    m = mws(k.applied("deleted the matching notes", applied_count=0, items=[]))
    assert m["outcome"] == "applied" and m["applied_count"] == 0 and m["items"] == []


def test_selector_items_by_id_and_count():
    r = k.partial(
        "closed 2 of 3 matched tickets",
        applied_count=2,
        items=[k.item(outcome="not_applied", id="T-9", code="locked")],
        read_with=k.read_with("list_tickets", status="open"),
    )
    m = mws(r)
    assert m["outcome"] == "partial" and m["items"] == [{"id": "T-9", "outcome": "not_applied", "code": "locked"}]


def test_all_or_nothing_refusal_takes_the_bad_items_code_and_per_item_conflicts():
    r = k.not_applied(
        "deleted none",
        items=[
            k.item(0, "not_applied", id="n-1", code="conflict", conflict=k.conflict_info(current_version=4, checked_by="backend", current_state={"t": 1})),
            k.item(1, "not_attempted", id="n-2"),
        ],
        read_with=k.read_with("list_notes"),
    )
    m = mws(r)
    assert m["code"] == "conflict" and m["repeat"] == "read_first" and "conflict" not in m
    assert m["items"][0]["conflict"]["current_version"] == 4


def test_object_parent():
    m = mws(k.applied("added a comment", object={"type": "comment", "id": 9, "parent": {"type": "ticket", "id": "T-1", "version": 5}}, changed=[""]))
    assert m["object"]["parent"] == {"type": "ticket", "id": "T-1", "version": 5}


def test_the_json_block_is_exactly_structured_content():
    for r in [k.applied("x", data={"n": "é"}), k.not_applied("y", code="not_found")]:
        assert texts(r)[1] == json.dumps(structured_of(r), separators=(",", ":"), ensure_ascii=False)


def test_golden_first_block_shared_with_the_typescript_kit():
    """tests/golden/first-sentence.json is the TypeScript kit's test/golden/first-sentence.json, byte for
    byte: the same shape and options give the same first text block in both kits (ALIGN.md, change n)."""
    from pathlib import Path

    cases = json.loads((Path(__file__).parent / "golden" / "first-sentence.json").read_text(encoding="utf-8"))
    assert cases
    for case in cases:
        o = case["options"]
        key = (o.get("keyArgument"), o.get("key")) if ("keyArgument" in o or "key" in o) else None
        version = (None, o["sentVersion"]) if "sentVersion" in o else None
        k.assert_shape({"mws": case["shape"]})
        text = k.render_text({"mws": case["shape"]}, o["summary"], o.get("notes", ()), key=key, version=version)
        assert text == case["text"], case["name"]


def test_a_complete_conflict_state_may_stand_in_for_the_read():
    t = texts(k.conflict("a", current_version=3, current_state={"t": 1}, read_tool="get", checked_by="backend"))[0]
    assert 'Build the write again from them, or read it with "get" and the arguments {"id":"a"}; do not resend your earlier values with the new version.' in t


def test_golden_file_has_the_pinned_sha256():
    """The same bytes as the TypeScript kit's test/golden/first-sentence.json and the spec's
    spec/shapes/first-sentence.json."""
    import hashlib
    from pathlib import Path

    data = (Path(__file__).parent / "golden" / "first-sentence.json").read_bytes()
    assert hashlib.sha256(data).hexdigest() == "5d6f8d965b3e21e148c3a31dea1af458c90892a68c274f33ce489d724d5d8326"


def test_not_permitted_is_reserved_with_not_applied_and_listed_in_the_schema():
    from pathlib import Path

    from mws_kit.result import CODES, ShapeError, assert_shape

    assert len(CODES) == 14 and CODES["not_permitted"] == "not_applied"
    schema = json.loads((Path(k.__file__).parent / "write-result-0.1.schema.json").read_text(encoding="utf-8"))
    for c in CODES:
        assert c in schema["properties"]["code"]["$comment"]
    assert_shape({"mws": {"shape": "write-result/0.1", "outcome": "not_applied", "repeat": "no", "code": "not_permitted"}})
    with pytest.raises(ShapeError):
        assert_shape({"mws": {"shape": "write-result/0.1", "outcome": "unknown", "repeat": "read_first", "code": "not_permitted"}})
