"""The write-result shape 0.1 (draft Annex B-9) and its text (MWS-RES-1, RES-2, RES-4, ATOM-1, CONC-4,
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
            "object": {"type": "note", "id": "n-3", "version": "4"},  # every object member is a string
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
            lambda: k.partial("x", items=[k.item(0, "applied", id="a"), k.item(1, "not_applied", id="b", code="not_found")]),
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
    assert "Nothing changed: the values were already as asked." in texts(k.applied("x", changed=[]))[0]


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
    )
    m = mws(r)
    assert m["outcome"] == "partial" and m["repeat"] == "read_first"
    t = texts(r)[0]
    assert 'Item 0 ("n-1"): applied.' in t and 'Item 1 ("n-2"): not applied: does not exist.' in t and 'Item 2 ("n-3"): not attempted.' in t
    r = k.partial("none", items=[k.item(0, "not_applied", id="a"), k.item(1, "not_attempted", id="b")])
    assert mws(r)["outcome"] == "not_applied"


def test_conflict_carries_state_and_version_unambiguously():
    r = k.conflict(
        "n-3",
        current_version="5",
        version_source="backend",
        current_state={"id": "n-3", "title": "v2 draft", "version": "5"},
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
            "current_version": "5",
            "version_source": "backend",
            "current_state": {"id": "n-3", "title": "v2 draft", "version": "5"},
            "omitted": ["/body"],
        },
        "read_with": {"tool": "get_note", "arguments": {"id": "n-3"}},
        "version_argument": "expected_version",
    }
    t = texts(r)[0]
    assert "Nothing was changed." in t
    assert 'Current version: "5" (send it as expected_version).' in t
    assert 'Current state (JSON): {"id":"n-3","title":"v2 draft","version":"5"}' in t
    assert 'Left out of the current state: "/body".' in t
    assert "Do not resend your earlier values" in t
    assert 'read with "get_note" and the arguments {"id":"n-3"}' in t


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
        ({"outcome": "applied", "object": {"id": 3}}, "is a string"),
        ({"outcome": "not_applied", "object": {"id": "a", "version": "3"}}, "object.version is left out"),
        ({"outcome": "applied", "changed": ["title"]}, "JSON Pointers"),
        ({"outcome": "not_applied", "argument": "title"}, "JSON Pointer"),
        ({"outcome": "partial", "items": [{"index": 0, "outcome": "applied"}]}, "at least one item applied and one not"),
        ({"outcome": "partial", "items": [{"index": 0, "outcome": "applied"}, {"index": 1, "outcome": "unknown"}]}, "makes the whole outcome unknown"),
        ({"outcome": "not_applied", "conflict": {"current_version": "1", "current_state": {}}}, 'only where code is "conflict"'),
        ({"outcome": "not_applied", "code": "conflict", "repeat": "no", "conflict": {"current_version": "1"}}, "current_state or with repeat"),
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
        k.partial("z", items=[k.item(0, "applied", id="a"), k.item(1, "not_attempted")], applied_count=1),
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
    assert k.read_result(CallToolResult(content=[], structuredContent={"mws": {"shape": "write-result/0.7", "outcome": "applied"}}))
    assert k.read_result(CallToolResult(content=[], structuredContent={"mws": {"shape": "write-result/1.0", "outcome": "applied"}})) is None
    assert k.read_result(k.read_answer({"id": "n-1"})) is None


def test_replay():
    first = k.applied('created note "n-1"', object={"id": "n-1", "version": 1}, changed=["/title"])
    again = k.as_replay(first)
    assert mws(again) == {**mws(first), "replayed": True}
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
    assert k.WRITE_RESULT_SCHEMA["properties"]["conflict"]["properties"]["current_version"] == {"type": "string"}
    assert k.WRITE_RESULT_SCHEMA["required"] == ["shape", "outcome"]
