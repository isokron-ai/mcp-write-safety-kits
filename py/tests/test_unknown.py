"""Unknown outcomes (MWS-RES-2)."""

from __future__ import annotations

import asyncio
import socket

import pytest

import mws_kit as k
from mws_kit._mcp import is_error_of, structured_of, text_of


class ReadTimeout(Exception):
    """Named like httpx's: sent, no answer."""


class ConnectError(Exception):
    """Named like httpx's: never connected."""


@pytest.mark.parametrize(
    "error, expected",
    [
        (k.NotAppliedError("refused"), "not_applied"),
        (k.OutcomeUnknownError("timeout"), "unknown"),
        (ConnectionRefusedError(), "not_applied"),
        (socket.gaierror(), "not_applied"),
        (ConnectError(), "not_applied"),
        (ConnectionResetError(), "unknown"),
        (TimeoutError(), "unknown"),
        (ReadTimeout(), "unknown"),
        (RuntimeError("anything"), "unknown"),
    ],
)
def test_classify_error(error, expected):
    assert k.classify_error(error) == expected


def test_classify_follows_the_cause():
    try:
        try:
            raise ConnectionRefusedError()
        except ConnectionRefusedError as inner:
            raise RuntimeError("wrapped") from inner
    except RuntimeError as e:
        assert k.classify_error(e) == "not_applied"


def m(r):
    return structured_of(r)["mws"]


def test_unknown_outcome_without_guard_names_the_read_and_does_not_invite_a_repeat():
    r = k.unknown_outcome(
        'the update to note "n-3" was sent and no answer arrived',
        read_with=k.read_with("get_note", id="n-3"),
        object={"type": "note", "id": "n-3"},
    )
    assert is_error_of(r)
    assert m(r) == {
        "shape": "write-result/0.1",
        "outcome": "unknown",
        "repeat": "read_first",
        "object": {"type": "note", "id": "n-3"},
        "code": "no_answer",
        "read_with": {"tool": "get_note", "arguments": {"id": "n-3"}},
    }
    t = r.content[0].text
    assert t.startswith('Outcome unknown: the update to note "n-3" was sent and no answer arrived. It is not known whether the change was applied.')
    assert 'Before writing again, read it with "get_note" and the arguments {"id":"n-3"} and build the write from what the read shows.' in t
    assert "try again" not in t.lower() and "retry" not in t.lower()


def test_unknown_outcome_with_key_or_version_guard():
    r = k.unknown_outcome("w", read_with=k.read_with("list_notes"), guard=k.RepeatGuard(idempotency_key=("idempotency_key", "k-1")))
    assert m(r)["repeat"] == "same_key"
    assert 'only with the same idempotency_key "k-1"' in r.content[0].text
    r = k.unknown_outcome("w", read_with=k.read_with("get_note"), guard=k.RepeatGuard(version=("expected_version", "4")))
    assert m(r)["repeat"] == "same_version"
    assert 'only with the same expected_version "4"' in r.content[0].text


def test_guard_write_maps_errors_and_hides_raw_messages():
    def lost():
        raise ConnectionResetError("https://api.example/x?token=SECRET")

    r = k.guard_write(lost, read_with=k.read_with("get_note", id="n-1"), what="the write was sent and no answer arrived", object={"id": "n-1"})
    assert m(r)["outcome"] == "unknown" and m(r)["code"] == "no_answer"
    assert "SECRET" not in text_of(r) and "Cause: ConnectionResetError" in text_of(r)

    def refused():
        raise ConnectionRefusedError("https://api.example/x?token=SECRET")

    r = k.guard_write(refused, read_with=k.read_with("get_note"), what="x")
    assert m(r)["outcome"] == "not_applied" and m(r)["code"] == "not_sent" and m(r)["repeat"] == "yes"
    assert "SECRET" not in text_of(r)

    def backend_no():
        raise k.NotAppliedError('note "n-1" is locked by another user', code="locked", object={"id": "n-1"})

    r = k.guard_write(backend_no, read_with=k.read_with("get_note"), what="x")
    assert m(r)["outcome"] == "not_applied" and m(r)["code"] == "locked" and m(r)["object"] == {"id": "n-1"}
    assert "locked by another user" in text_of(r)

    ok = k.applied("done")
    assert k.guard_write(lambda: ok, read_with=k.read_with("g"), what="x") is ok


def test_guard_write_async():
    async def lost():
        raise TimeoutError()

    r = asyncio.run(k.guard_write_async(lost, read_with=k.read_with("get_note"), what="x"))
    assert m(r)["outcome"] == "unknown"
    r = asyncio.run(k.guard_write_async(lambda: k.applied("ok"), read_with=k.read_with("get_note"), what="x"))
    assert m(r)["outcome"] == "applied"
