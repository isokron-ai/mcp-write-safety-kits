"""Retry keys (MWS-RETRY-1, RETRY-2; Annex B-5)."""

from __future__ import annotations

import asyncio
import threading
import time

import mws_kit as k
from mws_kit._mcp import is_error_of, text_of
from mws_kit._mcp import structured_of as _sc

RW = k.read_with("list")


def structured_of(r):
    return _sc(r)["mws"]


class Creator:
    def __init__(self, delay: float = 0.0):
        self.made: list[str] = []
        self.delay = delay
        self.lock = threading.Lock()

    def __call__(self, title: str):
        def write():
            time.sleep(self.delay)
            with self.lock:
                oid = f"n-{len(self.made) + 1}"
                self.made.append(title)
            return k.applied(f"created note {k.q(oid)}", object={"id": oid, "version": 1}, changed=["/title"])

        return write


def run(idem, creator, key, title):
    return idem.run(scope="create", key=key, arguments={"title": title, "idempotency_key": key}, write=creator(title), read_with=RW)


def test_same_key_same_arguments_is_applied_once_and_answered_with_the_first_result():
    idem, c = k.Idempotency(), Creator()
    first = run(idem, c, "key-1", "a")
    again = run(idem, c, "key-1", "a")
    assert c.made == ["a"]
    assert structured_of(again) == {**structured_of(first), "replayed": True}
    assert k.REPLAY_NOTE in text_of(again)


def test_new_key_is_a_new_write():
    idem, c = k.Idempotency(), Creator()
    run(idem, c, "key-1", "a")
    r = run(idem, c, "key-2", "a")
    assert c.made == ["a", "a"]
    assert k.REPLAY_NOTE not in text_of(r)


def test_same_key_different_arguments_is_refused():
    idem, c = k.Idempotency(), Creator()
    run(idem, c, "key-1", "a")
    r = run(idem, c, "key-1", "b")
    assert c.made == ["a"]
    assert is_error_of(r)
    assert structured_of(r)["outcome"] == "not_applied"
    assert structured_of(r)["code"] == "idempotency_key_reused" and structured_of(r)["argument"] == "/idempotency_key"
    assert 'the idempotency_key "key-1" was already used with different arguments' in text_of(r)


def test_no_key_is_not_tracked():
    idem, c = k.Idempotency(), Creator()
    run(idem, c, None, "a")
    run(idem, c, None, "a")
    assert c.made == ["a", "a"]


def test_not_applied_releases_the_key():
    idem = k.Idempotency()
    calls = []

    def refused():
        calls.append(1)
        return k.not_applied("refused by the backend")

    for _ in range(2):
        idem.run(scope="s", key="k", arguments={"x": 1}, write=refused, read_with=RW)
    assert len(calls) == 2  # nothing was applied, so the repeat is a new attempt


def test_unknown_outcome_is_kept_and_a_repeat_applies_nothing():
    idem = k.Idempotency()
    calls = []

    def lost():
        calls.append(1)
        raise TimeoutError()

    first = idem.run(scope="s", key="k", arguments={"x": 1}, write=lost, read_with=RW)
    assert structured_of(first)["outcome"] == "unknown"
    assert structured_of(first)["repeat"] == "read_first"
    again = idem.run(scope="s", key="k", arguments={"x": 1}, write=lost, read_with=RW)
    assert len(calls) == 1
    assert structured_of(again)["outcome"] == "unknown" and structured_of(again)["replayed"] is True


def test_request_not_sent_releases_the_key():
    idem = k.Idempotency()
    calls = []

    def down():
        calls.append(1)
        raise ConnectionRefusedError()

    for _ in range(2):
        r = idem.run(scope="s", key="k", arguments={}, write=down, read_with=RW)
        assert structured_of(r)["outcome"] == "not_applied"
    assert len(calls) == 2


def test_partial_result_is_kept():
    idem = k.Idempotency()
    calls = []

    def half():
        calls.append(1)
        return k.partial("x", items=[k.item(0, "applied", id=1), k.item(1, "not_applied", id=2)], read_with=RW)

    idem.run(scope="s", key="k", arguments={}, write=half, read_with=RW)
    idem.run(scope="s", key="k", arguments={}, write=half, read_with=RW)
    assert len(calls) == 1


def test_ttl_expiry():
    now = [1000.0]
    store = k.InMemoryIdempotencyStore(clock=lambda: now[0])
    idem, c = k.Idempotency(store, ttl=60), Creator()
    run(idem, c, "key-1", "a")
    now[0] += 59
    run(idem, c, "key-1", "a")
    assert c.made == ["a"]
    now[0] += 2
    run(idem, c, "key-1", "a")
    assert c.made == ["a", "a"]
    assert store.purge() == 0 and len(store) == 1


def test_threads_with_one_key_never_double_write():
    idem, c = k.Idempotency(), Creator(delay=0.02)
    results = []

    def go():
        results.append(run(idem, c, "key-1", "a"))

    ts = [threading.Thread(target=go) for _ in range(50)]
    [t.start() for t in ts]
    [t.join() for t in ts]
    assert c.made == ["a"]
    ids = {structured_of(r)["object"]["id"] for r in results}
    assert ids == {"n-1"}
    assert sum(1 for r in results if structured_of(r).get("replayed")) == 49


def test_asyncio_tasks_with_one_key_never_double_write():
    idem = k.Idempotency()
    made = []

    async def write():
        await asyncio.sleep(0.02)
        made.append(1)
        return k.applied("created", object={"id": "n-1"})

    async def main():
        return await asyncio.gather(
            *(idem.run_async(scope="s", key="k", arguments={"t": "a"}, write=write, read_with=RW) for _ in range(50))
        )

    results = asyncio.run(main())
    assert made == [1]
    assert all(structured_of(r)["object"]["id"] == "n-1" for r in results)


def test_threads_and_asyncio_share_one_store():
    idem = k.Idempotency()
    made = []
    lock = threading.Lock()

    def write():
        time.sleep(0.02)
        with lock:
            made.append(1)
        return k.applied("created", object={"id": "n-1"})

    async def amain():
        return await asyncio.gather(
            *(idem.run_async(scope="s", key="k", arguments={}, write=write, read_with=RW) for _ in range(10))
        )

    ts = [threading.Thread(target=lambda: idem.run(scope="s", key="k", arguments={}, write=write, read_with=RW)) for _ in range(10)]
    [t.start() for t in ts]
    asyncio.run(amain())
    [t.join() for t in ts]
    assert made == [1]


def test_in_progress_answer_after_wait():
    idem = k.Idempotency(wait=0.05)
    gate = threading.Event()
    out = {}

    def slow():
        gate.wait(2)
        return k.applied("created", object={"id": "n-1"})

    t = threading.Thread(target=lambda: out.setdefault("first", idem.run(scope="s", key="k", arguments={}, write=slow, read_with=RW)))
    t.start()
    time.sleep(0.02)
    r = idem.run(scope="s", key="k", arguments={}, write=slow, read_with=RW)
    gate.set()
    t.join()
    sh = structured_of(r)
    assert sh["outcome"] == "unknown" and sh["code"] == "in_progress" and sh["repeat"] == "same_key"
    assert "is still in progress, and this call applied nothing" in text_of(r)
    assert structured_of(out["first"])["outcome"] == "applied"


class AsyncStore:
    """An async store over the in-memory one (as an async database store would look)."""

    def __init__(self):
        self.inner = k.InMemoryIdempotencyStore()

    async def reserve(self, *a):
        return self.inner.reserve(*a)

    async def complete(self, *a):
        return self.inner.complete(*a)

    async def release(self, *a):
        return self.inner.release(*a)

    async def get(self, *a):
        return self.inner.get(*a)


def test_async_store():
    idem = k.Idempotency(AsyncStore())
    made = []

    async def write():
        made.append(1)
        return k.applied("created", object={"id": "n-1"})

    async def main():
        a = await idem.run_async(scope="s", key="k", arguments={"t": 1}, write=write, read_with=RW)
        b = await idem.run_async(scope="s", key="k", arguments={"t": 1}, write=write, read_with=RW)
        c = await idem.run_async(scope="s", key="k", arguments={"t": 2}, write=write, read_with=RW)
        return a, b, c

    a, b, c = asyncio.run(main())
    assert made == [1]
    assert structured_of(b)["replayed"] is True
    assert is_error_of(c)


def test_store_protocol_and_fingerprint():
    assert isinstance(k.InMemoryIdempotencyStore(), k.IdempotencyStore)
    assert k.fingerprint({"a": 1, "b": [1, 2]}) == k.fingerprint({"b": [1, 2], "a": 1})
    assert k.fingerprint({"a": 1, "key": "x"}, exclude=("key",)) == k.fingerprint({"a": 1, "key": "y"}, exclude=("key",))
    assert k.fingerprint({"a": 1}) != k.fingerprint({"a": "1"})
    assert "remembered for 24 hours" in k.Idempotency().describe()
