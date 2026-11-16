"""Retry keys: idempotency keys kept by the server (MWS-RETRY-1, RETRY-2; Annex B-5).

A create tool whose repeated call would create a second object should accept an idempotency key
(MWS-RETRY-1). Where it does, the key must be honoured (MWS-RETRY-2):

- the same key with the same arguments is applied at most once, and a repeat is answered with the
  first call's result, marked as a repeat;
- a different key is a new write;
- the same key with different arguments is refused.

:class:`Idempotency` does this around your write, with any store that follows
:class:`IdempotencyStore`. :class:`InMemoryIdempotencyStore` is the store for one server process.
It is safe for threads and for asyncio tasks: two concurrent calls with one key never both write.

What the in-memory store does not do (Annex B-5): its records are lost when the process stops, so a
repeat sent after a restart is applied again; and a second server process does not see them. Where
either matters, implement :class:`IdempotencyStore` over storage that survives a restart and that
every process shares, and write the record in the same transaction as the write where you can.
"""

from __future__ import annotations

import asyncio
import hashlib
import inspect
import json
import threading
import time
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from typing import Any, Literal, Protocol, Union, runtime_checkable

from ._mcp import CallToolResult
from .result import ReadWith, as_replay, not_applied, pointer, q, read_result, restate
from .unknown import RepeatGuard, classify_error, refusal_result, unknown_code, unknown_outcome

__all__ = [
    "KeyRecord",
    "IdempotencyStore",
    "AsyncIdempotencyStore",
    "InMemoryIdempotencyStore",
    "Idempotency",
    "fingerprint",
]


@dataclass(frozen=True)
class KeyRecord:
    """What a store keeps for one key.

    ``result`` is the first call's tool result as JSON (``CallToolResult.model_dump(by_alias=True,
    mode="json", exclude_none=True)``), present once ``state`` is ``"done"``.
    """

    fingerprint: str
    state: Literal["pending", "done"]
    created_at: float
    result: dict[str, Any] | None = None


@runtime_checkable
class IdempotencyStore(Protocol):
    """Storage for idempotency keys. ``scope`` separates tools (or tenants) that share a store.

    Every method must be atomic with respect to the others for one ``(scope, key)``.
    """

    def reserve(self, scope: str, key: str, fingerprint: str, ttl: float) -> KeyRecord | None:
        """If no live record exists for the key, create a pending one and return None.
        Otherwise return the existing record unchanged."""
        ...

    def complete(self, scope: str, key: str, result: dict[str, Any]) -> None:
        """Mark the key's record done, with the first call's result."""
        ...

    def release(self, scope: str, key: str) -> None:
        """Forget the key: the call that reserved it applied nothing."""
        ...

    def get(self, scope: str, key: str) -> KeyRecord | None:
        """The key's live record, or None."""
        ...


class AsyncIdempotencyStore(Protocol):
    """The same contract as :class:`IdempotencyStore`, with async methods (for an async database)."""

    async def reserve(self, scope: str, key: str, fingerprint: str, ttl: float) -> KeyRecord | None: ...
    async def complete(self, scope: str, key: str, result: dict[str, Any]) -> None: ...
    async def release(self, scope: str, key: str) -> None: ...
    async def get(self, scope: str, key: str) -> KeyRecord | None: ...


class InMemoryIdempotencyStore:
    """An :class:`IdempotencyStore` in this process's memory, with a time to live per record.

    Thread-safe; usable from asyncio code too (each operation is short and never blocks on I/O).
    Records are lost when the process stops (see the module documentation).
    """

    def __init__(self, *, clock: Callable[[], float] = time.monotonic, purge_every: float = 60.0) -> None:
        self._clock = clock
        self._lock = threading.Lock()
        self._records: dict[tuple[str, str], tuple[KeyRecord, float]] = {}
        self._purge_every = purge_every
        self._next_purge = clock() + purge_every

    def _purge_locked(self, now: float) -> int:
        dead = [k for k, (_, expires) in self._records.items() if now >= expires]
        for k in dead:
            del self._records[k]
        self._next_purge = now + self._purge_every
        return len(dead)

    def _live(self, k: tuple[str, str], now: float) -> KeyRecord | None:
        entry = self._records.get(k)
        if entry is None:
            return None
        record, expires = entry
        if now >= expires:
            del self._records[k]
            return None
        return record

    def reserve(self, scope: str, key: str, fingerprint: str, ttl: float) -> KeyRecord | None:
        now = self._clock()
        with self._lock:
            if now >= self._next_purge:  # expired records go at most this long after they expire
                self._purge_locked(now)
            existing = self._live((scope, key), now)
            if existing is not None:
                return existing
            self._records[(scope, key)] = (KeyRecord(fingerprint, "pending", now), now + ttl)
            return None

    def complete(self, scope: str, key: str, result: dict[str, Any]) -> None:
        with self._lock:
            entry = self._records.get((scope, key))
            if entry is not None:
                record, expires = entry
                self._records[(scope, key)] = (KeyRecord(record.fingerprint, "done", record.created_at, result), expires)

    def release(self, scope: str, key: str) -> None:
        with self._lock:
            self._records.pop((scope, key), None)

    def get(self, scope: str, key: str) -> KeyRecord | None:
        with self._lock:
            return self._live((scope, key), self._clock())

    def purge(self) -> int:
        """Drop expired records now; returns how many were dropped. (Expired records are also
        dropped when they are next looked up, and all of them on the first ``reserve`` after
        ``purge_every`` seconds.)"""
        now = self._clock()
        with self._lock:
            return self._purge_locked(now)

    def __len__(self) -> int:
        with self._lock:
            return len(self._records)


def fingerprint(arguments: Mapping[str, Any], *, exclude: tuple[str, ...] = ()) -> str:
    """A stable hash of a call's arguments (canonical JSON, keys sorted), leaving out ``exclude``."""
    body = {k: v for k, v in arguments.items() if k not in exclude}
    text = json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


_DEFAULT_WHAT = "the write was sent and no answer arrived"


def _dump(result: CallToolResult) -> dict[str, Any]:
    return result.model_dump(by_alias=True, mode="json", exclude_none=True)


def _load(data: Mapping[str, Any]) -> CallToolResult:
    return CallToolResult.model_validate(dict(data))


_Store = Union[IdempotencyStore, AsyncIdempotencyStore]


async def _maybe(x: Any) -> Any:
    return await x if inspect.isawaitable(x) else x


class Idempotency:
    """Runs writes at most once per idempotency key (MWS-RETRY-2).

    :param store: where keys are kept (default: a new :class:`InMemoryIdempotencyStore`).
    :param ttl: how long a key is remembered, in seconds (default 24 hours). State it in the tool's
        description, with the instruction to send the same key when retrying the same write
        (MWS-RETRY-1 guidance); :meth:`describe` gives a sentence for that.
    :param wait: how long a repeat waits for a first call with the same key that is still in
        progress, in seconds, before answering that it is still in progress.
    :param key_arg: the name of the tool argument that carries the key, for texts and for leaving
        the key out of the fingerprint.

    How a first call's result is kept, by its MWS outcome:

    - ``applied``, ``partial``, ``unknown`` or ``accepted``: kept; a repeat is answered with it,
      with ``replayed: true``, and applies nothing.
    - ``not_applied``: the key is released, so the same call can be sent again and is a new attempt.
    - a result without the MWS shape: kept if it is a success or an error (an error without the
      shape cannot say whether something was applied, so it is not released).
    - an exception: classified by :func:`mws_kit.classify_error`. A request that was never sent
      releases the key; anything else is kept as an unknown outcome (``no_answer`` for a lost
      answer, ``internal_error`` otherwise).

    Every answer to a keyed call describes the write that the key identifies (B-9, "A repeat with
    a key"): the first answer and its replays have ``repeat: "same_key"`` (except ``not_applied``),
    and a replay keeps the first answer's ``outcome``, ``code``, ``object`` and ``changed`` and adds
    ``replayed: true``.

    ``refuse_unvouched_keys``: a key with no record that is a UUIDv7 created before this
    Idempotency started is answered ``unknown`` with ``code: "key_not_known"`` and
    ``repeat: "read_first"``, and nothing is applied: the record of that key may have been lost in
    a restart (Annex B-5). Keys of other forms are treated as new.
    """

    def __init__(
        self,
        store: _Store | None = None,
        *,
        ttl: float = 86_400.0,
        wait: float = 10.0,
        key_arg: str = "idempotency_key",
        poll: float = 0.005,
        refuse_unvouched_keys: bool = False,
    ) -> None:
        self.store: _Store = store if store is not None else InMemoryIdempotencyStore()
        self.ttl = ttl
        self.wait = wait
        self.key_arg = key_arg
        self.poll = poll
        self.refuse_unvouched_keys = refuse_unvouched_keys
        #: When this Idempotency (and so an in-memory store) started, in Unix seconds.
        self.started = time.time()

    def describe(self) -> str:
        """A sentence for the tool's description (MWS-RETRY-1 guidance)."""
        hours = self.ttl / 3600
        span = f"{hours:g} hours" if hours >= 1 else f"{self.ttl:g} seconds"
        return (
            f"Optional {self.key_arg}: a value you choose for this write. If you retry the same write, send the same "
            f"{self.key_arg} and the same arguments: it is applied at most once, and the repeat returns the first "
            f"result. A key is remembered for {span}. Reusing a key with different arguments is refused."
        )

    # -- results --------------------------------------------------------------------------------

    def _reuse_refused(self, key: str) -> CallToolResult:
        return not_applied(
            f"the {self.key_arg} {q(key)} was already used with different arguments",
            code="idempotency_key_reused",
            message=f"a call with this {self.key_arg} and other arguments was made earlier",
            argument=pointer(self.key_arg),
            notes=[
                f"Use a new {self.key_arg} for a different write, or send the first call's arguments with this "
                f"{self.key_arg} to get its result"
            ],
        )

    def _in_progress(self, key: str, read_with: ReadWith | Mapping[str, Any]) -> CallToolResult:
        return unknown_outcome(
            f"a call with the same {self.key_arg} {q(key)} is still in progress, and this call applied nothing",
            read_with=read_with,
            code="in_progress",
            replayed=True,
            guard=RepeatGuard(idempotency_key=(self.key_arg, key)),
        )

    def _after_exception(self, key: str, e: BaseException, read_with: ReadWith | Mapping[str, Any], what: str) -> tuple[CallToolResult, bool]:
        """The result for an exception raised by the write, and whether to keep the key."""
        refused = refusal_result(e, read_with=read_with) if isinstance(e, Exception) else None
        if refused is not None:
            # A settled refusal releases the key; a code that implies an open outcome keeps it.
            if (read_result(refused) or {}).get("outcome") == "not_applied":
                return refused, False
            return restate(refused, {}, notes=[self._open_note(key)]), True
        cause = str(e) if type(e).__name__ == "OutcomeUnknownError" and str(e) else type(e).__name__
        # The key is kept, so a repeat with it applies nothing and gets this same answer back: telling
        # the caller to repeat with the key would never settle the outcome. The read settles it.
        code = unknown_code(e)
        if code != "no_answer" and what == _DEFAULT_WHAT:
            what = "the write stopped on a fault in the server after it may have been sent"
        return (
            unknown_outcome(
                what,
                read_with=read_with,
                cause=cause,
                code=code,
                notes=[
                    f"A repeat with the same {self.key_arg} {q(key)} applies nothing and returns this answer. If the "
                    f"read shows that the write was not applied, send it again with a new {self.key_arg}"
                ],
            ),
            True,
        )

    def _key_not_known(self, key: str, read_with: ReadWith | Mapping[str, Any]) -> CallToolResult:
        return unknown_outcome(
            f"this server has no record of the {self.key_arg} {q(key)}, which was made before it started, and this "
            "call applied nothing",
            read_with=read_with,
            code="key_not_known",
            replayed=True,
            notes=["An earlier call with this key may have been applied before a restart"],
        )

    def _unvouched(self, key: str) -> bool:
        if not self.refuse_unvouched_keys:
            return False
        ms = _uuid7_ms(key)
        return ms is not None and ms / 1000 < self.started

    def _open_note(self, key: str) -> str:
        return (
            f"A repeat with the same {self.key_arg} {q(key)} applies nothing and returns this answer. If the "
            f"read shows that the write was not applied, send it again with a new {self.key_arg}"
        )

    def _first_answer(self, result: CallToolResult, key: str) -> CallToolResult:
        """The first answer to a keyed call: ``repeat: "same_key"`` where the write the key identifies
        was applied, accepted or partly applied. Where its outcome is open, ``repeat: "read_first"``
        with the read, and a note to use a new key once the read shows nothing was applied: the key
        is kept, so a repeat with it only replays the open answer (B-9 allows read_first with
        unknown)."""
        shape = read_result(result)
        if shape is None or shape.get("outcome") in (None, "not_applied") or shape.get("code") == "conflict":
            return result
        if shape.get("outcome") == "unknown":
            obj = shape.get("object") or {}
            if shape.get("repeat") == "read_first" or not (shape.get("read_with") or obj.get("id") is not None):
                return result
            return restate(result, {"repeat": "read_first", "version_argument": None}, notes=[self._open_note(key)])
        if shape.get("repeat") == "same_key":
            return result
        return restate(result, {"repeat": "same_key"}, key=(self.key_arg, key))

    @staticmethod
    def _keep(result: CallToolResult) -> bool:
        shape = read_result(result)
        if shape is None:
            return True
        return shape.get("outcome") != "not_applied"

    # -- sync -----------------------------------------------------------------------------------

    def run(
        self,
        *,
        scope: str,
        key: str | None,
        arguments: Mapping[str, Any],
        write: Callable[[], CallToolResult],
        read_with: ReadWith | Mapping[str, Any],
        what: str = _DEFAULT_WHAT,
    ) -> CallToolResult:
        """Run ``write`` at most once for ``key`` (no key: just run it).

        :param scope: separates tools that share a store (use the tool's name).
        :param arguments: the call's arguments, for the fingerprint (the key argument is left out).
        :param read_with: the read that settles an unknown outcome (:func:`mws_kit.read_with`).
        :param what: the sentence for an unknown outcome when ``write`` raises.
        """
        if key is None:
            return write()
        if inspect.iscoroutinefunction(self.store.reserve):
            raise TypeError("the store is async; use run_async")
        store: IdempotencyStore = self.store  # type: ignore[assignment]
        fp = fingerprint(arguments, exclude=(self.key_arg,))
        if self._unvouched(key) and store.get(scope, key) is None:
            return self._key_not_known(key, read_with)
        deadline = time.monotonic() + self.wait
        while True:
            record = store.reserve(scope, key, fp, self.ttl)
            if record is None:
                break
            if record.fingerprint != fp:
                return self._reuse_refused(key)
            if record.state == "done" and record.result is not None:
                return as_replay(_load(record.result), key=(self.key_arg, key))
            if time.monotonic() >= deadline:
                return self._in_progress(key, read_with)
            time.sleep(self.poll)
        try:
            result = self._first_answer(write(), key)
        except BaseException as e:
            result, keep = self._after_exception(key, e, read_with, what)
            if keep:
                store.complete(scope, key, _dump(result))
            else:
                store.release(scope, key)
            if not isinstance(e, Exception):
                raise
            return result
        if self._keep(result):
            store.complete(scope, key, _dump(result))
        else:
            store.release(scope, key)
        return result

    # -- async ----------------------------------------------------------------------------------

    async def run_async(
        self,
        *,
        scope: str,
        key: str | None,
        arguments: Mapping[str, Any],
        write: Callable[[], Awaitable[CallToolResult] | CallToolResult],
        read_with: ReadWith | Mapping[str, Any],
        what: str = _DEFAULT_WHAT,
    ) -> CallToolResult:
        """The async form of :meth:`run`; ``write`` and the store may be sync or async."""
        if key is None:
            return await _maybe(write())
        fp = fingerprint(arguments, exclude=(self.key_arg,))
        if self._unvouched(key) and await _maybe(self.store.get(scope, key)) is None:
            return self._key_not_known(key, read_with)
        deadline = time.monotonic() + self.wait
        while True:
            record = await _maybe(self.store.reserve(scope, key, fp, self.ttl))
            if record is None:
                break
            if record.fingerprint != fp:
                return self._reuse_refused(key)
            if record.state == "done" and record.result is not None:
                return as_replay(_load(record.result), key=(self.key_arg, key))
            if time.monotonic() >= deadline:
                return self._in_progress(key, read_with)
            await asyncio.sleep(self.poll)
        try:
            result = self._first_answer(await _maybe(write()), key)
        except BaseException as e:  # includes cancellation: the write may have been sent
            result, keep = self._after_exception(key, e, read_with, what)
            if keep:
                await _maybe(self.store.complete(scope, key, _dump(result)))
            else:
                await _maybe(self.store.release(scope, key))
            if not isinstance(e, Exception):
                raise
            return result
        if self._keep(result):
            await _maybe(self.store.complete(scope, key, _dump(result)))
        else:
            await _maybe(self.store.release(scope, key))
        return result


def _uuid7_ms(key: str) -> int | None:
    """The creation time in milliseconds of a key that is a UUID version 7, else None."""
    import uuid

    try:
        u = uuid.UUID(key)
    except ValueError:
        return None
    if u.version != 7:
        return None
    return u.int >> 80
