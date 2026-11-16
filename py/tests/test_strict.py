"""Strict inputs (MWS-IN-1, IN-2, IN-3, IN-4, IN-6, IN-7), including the spec's probe list, version 1."""

from __future__ import annotations

import pytest

import mws_kit as k
from mws_kit._mcp import is_error_of, structured_of, text_of

SCHEMA = k.strict_schema(
    {
        "type": "object",
        "properties": {
            "flag": {"type": "boolean"},
            "count": {"type": "integer", "minimum": 0, "maximum": 10},
            "ratio": {"type": "number", "multipleOf": 0.5},
            "name": {"type": "string", "minLength": 1, "maxLength": 5, "pattern": "^[a-z]+$"},
            "status": {"enum": ["open", "done"]},
            "kind": {"const": "note"},
            "tags": {"type": "array", "items": {"type": "string"}, "minItems": 1, "maxItems": 3, "uniqueItems": True},
            "assignee": {"anyOf": [{"type": "string"}, {"type": "null"}], "default": None},
            "details": {"type": "object", "properties": {"severity": {"type": "string"}}},
        },
        "required": ["name"],
    }
)

BASE = {"name": "abc"}


def issues(**args):
    return k.check_arguments(SCHEMA, {**BASE, **args})


def test_valid_call_has_no_issues():
    assert issues(flag=True, count=3, ratio=1.5, status="open", kind="note", tags=["a", "b"], assignee=None, details={"severity": "hi"}) == []
    assert issues(count=5.0) == []  # 5.0 is an integer in JSON Schema
    assert issues(ratio=2) == []  # an integer is a number


# Probe list, version 1 (spec MWS-IN-1): every probe of another type than declared is refused.
@pytest.mark.parametrize("probe", ["false", "true", "yes", 0, 1, None, {"a": 1}, [1]])
def test_boolean_probes_refused(probe):
    found = issues(flag=probe)
    assert found and found[0].path == ("flag",)
    assert "expected boolean" in found[0].reason


@pytest.mark.parametrize("probe", ["5", "abc", "", None, True, 0.5, {"a": 1}, [1]])
def test_integer_probes_refused(probe):
    found = issues(count=probe)
    assert found and found[0].path == ("count",) and "expected integer" in found[0].reason


@pytest.mark.parametrize("probe", ["5", "abc", "", None, True, {"a": 1}, [1]])
def test_number_probes_refused(probe):
    found = issues(ratio=probe)
    assert found and "expected number" in found[0].reason


@pytest.mark.parametrize("probe", [5, True, None, {"a": 1}, [1]])
def test_string_probes_refused(probe):
    found = issues(name=probe)
    assert found and "expected string" in found[0].reason


def test_null_allowed_where_declared():
    assert issues(assignee=None) == []
    found = issues(assignee=5)
    assert found[0].reason == "expected string or null, got number 5"


def test_unknown_argument_refused_with_a_hint():
    found = issues(asignee="ann")
    assert found[0].path == ("asignee",)
    assert found[0].reason == 'is not an argument of this tool and was not used (did you mean "assignee"?)'
    assert issues(zzz_unrelated=1)[0].reason == "is not an argument of this tool and was not used"


def test_nested_unknown_argument_refused():
    found = issues(details={"severty": "hi"})
    assert found[0].path == ("details", "severty") and found[0].argument == "details.severty"
    assert "is not an argument of this object" in found[0].reason


@pytest.mark.parametrize(
    "args, reason",
    [
        ({"count": -1}, "must be at least 0"),
        ({"count": 11}, "must be at most 10"),
        ({"count": 10**12}, "must be at most 10"),
        ({"ratio": 0.3}, "must be a multiple of 0.5"),
        ({"name": ""}, "must be at least 1 characters long"),
        ({"name": "abcdef"}, "must be at most 5 characters long"),
        ({"name": "AB"}, "must match the pattern"),
        ({"status": "archived"}, 'must be one of "open", "done"; got string "archived"'),
        ({"kind": "task"}, 'must be "note"'),
        ({"tags": []}, "must have at least 1 items"),
        ({"tags": ["a", "b", "c", "d"]}, "must have at most 3 items"),
        ({"tags": ["a", "a"]}, "must not repeat an item"),
    ],
)
def test_constraints_refused(args, reason):
    found = issues(**args)
    assert found and reason in found[0].reason


def test_required_argument():
    found = k.check_arguments(SCHEMA, {})
    assert found[0].path == ("name",) and found[0].reason == "is required and was not sent"


def test_list_item_path():
    found = issues(tags=["a", 5])
    assert found[0].argument == "tags[1]"


def test_refs_are_followed():
    schema = k.strict_schema(
        {
            "type": "object",
            "properties": {"item": {"$ref": "#/$defs/Item"}},
            "$defs": {"Item": {"type": "object", "properties": {"n": {"type": "integer"}}}},
        }
    )
    assert schema["$defs"]["Item"]["additionalProperties"] is False
    assert k.check_arguments(schema, {"item": {"n": 1}}) == []
    assert k.check_arguments(schema, {"item": {"n": "1"}})[0].argument == "item.n"
    assert k.check_arguments(schema, {"item": {"m": 1}})[0].argument == "item.m"


def test_strict_schema_adds_additional_properties_false_and_keeps_explicit():
    s = k.strict_schema({"type": "object", "properties": {"a": {"type": "object", "additionalProperties": {"type": "integer"}}}})
    assert s["additionalProperties"] is False
    assert s["properties"]["a"]["additionalProperties"] == {"type": "integer"}
    assert k.check_arguments(s, {"a": {"x": 1}}) == []
    assert k.check_arguments(s, {"a": {"x": "1"}})[0].argument == "a.x"


def test_unsupported_keyword_fails_closed():
    with pytest.raises(k.UnsupportedSchema):
        k.strict_schema({"type": "object", "properties": {"a": {"not": {"type": "string"}}}})
    with pytest.raises(k.UnsupportedSchema):
        k.check_arguments({"type": "object", "if": {}}, {})


def test_arguments_must_be_an_object():
    assert k.check_arguments(SCHEMA, ["a"])[0].reason.startswith("the arguments must be an object")


def test_refusal_result_names_argument_expected_and_sent_and_says_nothing_changed():
    r = k.refuse_arguments("update_note", issues(count="5", asignee="x"))
    assert is_error_of(r)
    m = structured_of(r)["mws"]
    assert m["outcome"] == "not_applied" and m["code"] == "invalid_argument" and m["repeat"] == "no"
    assert m["argument"] == "/count"
    t = text_of(r)
    assert t.startswith('Not applied: argument "count" was refused: expected integer, got string "5" (1 more below). Nothing was changed.')
    assert m["argument_errors"][1] == {
        "argument": "/asignee",
        "code": "invalid_argument",
        "message": 'is not an argument of this tool and was not used (did you mean "assignee"?)',
    }
    assert 'Argument "asignee": is not an argument of this tool and was not used (did you mean "assignee"?).' in t


def test_long_values_are_cut():
    found = issues(count="x" * 500)
    assert len(found[0].reason) < 120 and found[0].reason.endswith('…')
