"""Version check (MWS-CONC-2, CONC-4, CONC-6)."""

from __future__ import annotations

import asyncio
import threading
import time

import pytest

import mws_kit as k
from mws_kit._mcp import is_error_of, text_of
from mws_kit._mcp import structured_of as _sc


def structured_of(r):
    return _sc(r)["mws"]


class Store:
    """A store whose write does no version check of its own (the guard's comparison is all there is)."""

    def __init__(self, check_in_write: bool = False, delay: float = 0.0):
        self.obj = {"id": "a", "title": "one", "body": "b", "version": 1}
        self.writes = 0
        self.check_in_write = check_in_write
        self.delay = delay
        self.lock = threading.Lock()

    def read(self, id):
        return None if self.obj is None else k.Snapshot(dict(self.obj), self.obj["version"])

    def write(self, id, change, expected):
        with self.lock:
            if self.check_in_write and expected != self.obj["version"]:
                raise k.VersionConflict(k.Snapshot(dict(self.obj), self.obj["version"]))
            time.sleep(self.delay)
            self.writes += 1
            if change is None:
                self.obj = None
                return None
            self.obj = {**self.obj, **change, "version": self.obj["version"] + 1}
            return k.Snapshot(dict(self.obj), self.obj["version"])


def guard(store, **kw):
    return k.VersionGuard(read=store.read, write=store.write, read_tool="get_thing", noun="thing", **kw)


def test_matching_version_writes_and_returns_a_receipt():
    s = Store()
    r = guard(s).apply("a", 1, {"title": "two"})
    assert structured_of(r) == {
        "shape": "write-result/0.1",
        "outcome": "applied",
        "repeat": "no",
        "operation": "update",
        "object": {"id": "a", "version": "2"},
        "changed": ["/title"],
    }
    assert s.obj["title"] == "two"


def test_mismatch_is_a_conflict_nothing_written_current_state_carried():
    s = Store()
    s.obj.update(title="other writer", version=2)
    r = guard(s).apply("a", 1, {"body": "mine"})
    sh = structured_of(r)
    assert is_error_of(r)
    assert sh["outcome"] == "not_applied"
    assert sh["code"] == "conflict" and sh["repeat"] == "read_first"
    assert sh["conflict"]["current_version"] == 2  # as the backend gives it, so it can be sent back
    assert sh["conflict"]["version_source"] == "backend"
    assert sh["conflict"]["current_state"]["title"] == "other writer"
    assert sh["read_with"] == {"tool": "get_thing", "arguments": {"id": "a"}}
    assert sh["version_argument"] == "expected_version"
    assert s.writes == 0 and s.obj["body"] == "b"
    assert "Nothing was changed." in text_of(r)


def test_version_required_by_default_and_optional_when_asked():
    s = Store()
    r = guard(s).apply("a", None, {"title": "x"})
    assert is_error_of(r) and s.writes == 0
    assert structured_of(r)["code"] == "version_required" and structured_of(r)["argument"] == "/expected_version"
    assert "expected_version is required" in text_of(r)
    r = guard(s, require_version=False).apply("a", None, {"title": "x"})
    assert structured_of(r)["outcome"] == "applied"


def test_missing_object_is_not_applied():
    s = Store()
    s.obj = None
    r = guard(s).apply("a", 1, {"title": "x"})
    assert structured_of(r)["outcome"] == "not_applied" and structured_of(r)["code"] == "not_found"
    assert 'thing "a" does not exist' in text_of(r)


def test_no_op_reports_no_changed_fields():
    s = Store()
    r = guard(s).apply("a", 1, {"title": "one"})
    assert structured_of(r)["changed"] == []


def test_backend_detected_conflict():
    s = Store(check_in_write=True)
    g = guard(s)
    # The guard's pre-check passes; the backend refuses because another writer slipped in.
    orig_read = s.read
    calls = {"n": 0}

    def stale_read(id):
        calls["n"] += 1
        snap = orig_read(id)
        if calls["n"] == 1:
            s.obj["version"] = 9  # changed between the guard's read and the write
            return snap
        return snap

    g.read = stale_read
    r = g.apply("a", 1, {"title": "x"})
    assert structured_of(r)["conflict"]["current_version"] == 9


def test_lost_answer_is_unknown_with_version_guard():
    s = Store()

    def lost(id, change, expected):
        s.writes += 1
        raise TimeoutError()

    g = k.VersionGuard(read=s.read, write=lost, read_tool="get_thing", noun="thing")
    r = g.apply("a", 1, {"title": "x"})
    sh = structured_of(r)
    assert sh["outcome"] == "unknown" and sh["code"] == "no_answer" and sh["repeat"] == "same_version"
    assert sh["read_with"] == {"tool": "get_thing", "arguments": {"id": "a"}}
    assert "only with the same expected_version 1" in text_of(r)


def test_request_not_sent_is_not_applied():
    s = Store()

    def down(id, change, expected):
        raise ConnectionRefusedError()

    r = k.VersionGuard(read=s.read, write=down, read_tool="get_thing").apply("a", 1, {"title": "x"})
    assert structured_of(r)["outcome"] == "not_applied" and structured_of(r)["code"] == "not_sent"


def test_delete():
    s = Store()
    r = guard(s).delete("a", 1)
    assert structured_of(r) == {"shape": "write-result/0.1", "outcome": "applied", "repeat": "no", "operation": "delete", "object": {"id": "a"}}
    assert text_of(r).startswith('Applied: deleted thing "a".')
    assert s.obj is None


def test_threads_with_one_version_write_once():
    s = Store(delay=0.002)
    g = guard(s)
    results = []

    def go(i):
        results.append(g.apply("a", 1, {"title": f"t{i}"}))

    ts = [threading.Thread(target=go, args=(i,)) for i in range(20)]
    [t.start() for t in ts]
    [t.join() for t in ts]
    outcomes = sorted(structured_of(r)["outcome"] for r in results)
    assert outcomes.count("applied") == 1 and outcomes.count("not_applied") == 19
    assert s.writes == 1


def test_async_tasks_with_one_version_write_once():
    s = Store()

    async def write(id, change, expected):
        await asyncio.sleep(0.002)
        return s.write(id, change, expected)

    g = k.VersionGuard(read=s.read, write=write, read_tool="get_thing")

    async def main():
        return await asyncio.gather(*(g.apply_async("a", 1, {"title": f"t{i}"}) for i in range(20)))

    results = asyncio.run(main())
    assert [structured_of(r)["outcome"] for r in results].count("applied") == 1
    assert s.writes == 1


def test_sync_apply_refuses_async_callables():
    async def read(id):
        return None

    g = k.VersionGuard(read=read, write=lambda *a: None, read_tool="g")
    with pytest.raises(TypeError):
        g.apply("a", 1, {})


def test_changed_fields_are_pointers():
    assert k.changed_fields({"a": 1, "b": 2, "v": 1}, {"a": 1, "b": 3, "c": 0, "v": 2}, ignore=["v"]) == ["/b", "/c"]
    assert k.changed_fields({"d": {"x": 1, "y": 2}}, {"d": {"x": 1, "y": 3}}) == ["/d/y"]


def test_omit_and_data_key():
    s = Store()
    s.obj["secret"] = "s3cr3t"
    s.obj["version"] = 2
    g = guard(s, omit=["secret"], object_type="thing", data_key="thing")
    r = g.apply("a", 1, {"title": "x"})
    c = structured_of(r)["conflict"]
    assert "secret" not in c["current_state"] and c["omitted"] == ["/secret"]
    assert "s3cr3t" not in text_of(r)
    r = g.apply("a", 2, {"title": "x"})
    assert _sc(r)["thing"]["title"] == "x" and structured_of(r)["object"]["type"] == "thing"
