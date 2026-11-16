"""Version check: a compare-and-set wrapper around your own read and write (MWS-CONC-2, CONC-4,
CONC-6; Annex B-2, B-3, B-4).

You give two callables:

- ``read(id) -> Snapshot | None``: the object's current state and version, or None if it does not
  exist;
- ``write(id, change, expected_version) -> Snapshot | None``: apply ``change`` and return the
  object's new state and version (None for a delete).

:class:`VersionGuard` compares the version the caller sent with the current one and refuses a
mismatch with a conflict result that says nothing was applied and carries the current version and
state. Otherwise it calls ``write`` and returns a receipt naming the fields that changed and the new
version.

Where the backend can check the version itself (an ``If-Match`` precondition, a conditional
update), pass ``expected_version`` on to it in ``write`` and raise :class:`VersionConflict` when it
refuses: that is the reliable form (Annex B-2). The comparison the guard makes before calling
``write`` is a best-effort check (Annex B-3): it is made under a per-object lock inside this
process (Annex B-4), so two calls through this process cannot interleave between the comparison and
the write, but a writer that reaches the backend another way, or a second server process, can. Where
that is possible and the backend cannot check the version, say so in the tool's description
(MWS-CONC-5, Annex B-8).
"""

from __future__ import annotations

import asyncio
import inspect
import threading
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Generic, TypeVar

from ._mcp import CallToolResult
from .result import applied, conflict, not_applied, pointer, q
from .unknown import NotAppliedError, OutcomeUnknownError, RepeatGuard, classify_error, unknown_outcome

__all__ = ["Snapshot", "VersionConflict", "VersionGuard", "changed_fields"]

C = TypeVar("C")
Id = Any
Version = Any


@dataclass(frozen=True)
class Snapshot:
    """An object's state, as the read tool returns it, and its version."""

    state: Mapping[str, Any]
    version: Version


class VersionConflict(Exception):
    """Raised by ``write`` when the backend refused the write because the version did not match.

    Give the object's current snapshot where the backend's refusal carries it; otherwise the guard
    reads it.
    """

    def __init__(self, current: Snapshot | None = None) -> None:
        super().__init__("version conflict")
        self.current = current


def changed_fields(before: Mapping[str, Any], after: Mapping[str, Any], *, ignore: Sequence[str] = ()) -> list[str]:
    """The fields whose values differ between two states, as JSON Pointers (``"/title"``), in a
    stable order. Nested objects are compared field by field (``"/details/severity"``); lists and
    other values as a whole."""
    out: list[str] = []

    def walk(a: Mapping[str, Any], b: Mapping[str, Any], path: tuple[str, ...]) -> None:
        keys = list(a.keys()) + [k for k in b.keys() if k not in a]
        for k in keys:
            if not path and k in ignore:
                continue
            x, y = a.get(k, _MISSING), b.get(k, _MISSING)
            if isinstance(x, Mapping) and isinstance(y, Mapping):
                walk(x, y, (*path, k))
            elif x != y:
                out.append(pointer(*path, k))

    walk(before, after, ())
    return out


_MISSING = object()


def _same_version(a: Any, b: Any) -> bool:
    if isinstance(a, bool) or isinstance(b, bool):
        return a is b
    return a == b or str(a) == str(b)


@dataclass
class VersionGuard(Generic[C]):
    """Compare-and-set for one kind of object.

    :param read: ``read(id) -> Snapshot | None``; sync or async.
    :param write: ``write(id, change, expected_version) -> Snapshot | None``; sync or async. Raise
        :class:`VersionConflict` if the backend refuses the version, :class:`NotAppliedError` for any
        other refusal, :class:`OutcomeUnknownError` (or let a timeout propagate) when the answer was
        lost.
    :param read_tool: the read tool's name, for the conflict and unknown-outcome texts.
    :param noun: what the object is called in sentences ("note").
    :param version_arg: the write tool's argument that takes the version.
    :param require_version: refuse a write that carries no version (the default). With False, a
        write without a version is applied unchecked, which MWS-CONC-2 allows only for a field-patch
        tool: for a tool that replaces a whole object or deletes, keep it True or offer an explicit
        override argument that is off by default (MWS-CONC-1, CONC-2 guidance).
    :param ignore: fields left out of ``changed`` (server-managed fields such as timestamps); the
        version field is always left out.
    :param version_field: the name of the version in the state, left out of ``changed``.
    :param omit: fields left out of the current state a conflict carries: any field the caller may
        not read through the read tool, any secret, and long histories. They are listed in
        ``conflict.omitted``.
    :param version_source: ``"backend"`` where the version is the backend's own, ``"server"`` where
        the server derives it (Annex B-3: a best-effort check).
    :param object_type: ``object.type`` in results (``"note"``).
    :param id_argument: the read tool's argument that takes the id, for ``read_with``.
    :param data_key: on a receipt, also return the object's new state as the tool's own output under
        this member (``{"note": {...}, "mws": {...}}``).
    """

    read: Callable[[Id], Snapshot | None | Awaitable[Snapshot | None]]
    write: Callable[[Id, C, Version | None], Snapshot | None | Awaitable[Snapshot | None]]
    read_tool: str
    noun: str = "object"
    version_arg: str = "expected_version"
    require_version: bool = True
    ignore: Sequence[str] = ()
    version_field: str = "version"
    omit: Sequence[str] = ()
    version_source: str = "backend"
    object_type: str | None = None
    id_argument: str = "id"
    data_key: str | None = None
    _locks: dict[Any, threading.Lock] = field(default_factory=dict, init=False, repr=False)
    _locks_guard: threading.Lock = field(default_factory=threading.Lock, init=False, repr=False)

    # -- locking --------------------------------------------------------------------------------

    def _lock_for(self, id: Id) -> threading.Lock:  # noqa: A002
        with self._locks_guard:
            lock = self._locks.get(id)
            if lock is None:
                lock = self._locks[id] = threading.Lock()
            return lock

    async def _acquire_async(self, lock: threading.Lock) -> None:
        # A threading lock, polled without blocking the event loop, so that sync and async callers
        # of one guard exclude each other. Cancellation while waiting leaves the lock untouched.
        delay = 0.0005
        while not lock.acquire(blocking=False):
            await asyncio.sleep(delay)
            delay = min(delay * 2, 0.01)

    # -- texts ----------------------------------------------------------------------------------

    def _read_with(self, id: Id) -> dict[str, Any]:  # noqa: A002
        return {"tool": self.read_tool, "arguments": {self.id_argument: id}}

    def _obj(self, id: Id, version: Version | None = None) -> dict[str, Any]:  # noqa: A002
        return {"type": self.object_type, "id": id, "version": version}

    def _missing(self, id: Id, operation: str) -> CallToolResult:  # noqa: A002
        return not_applied(
            f"{self.noun} {q(id)} does not exist",
            code="not_found",
            message=f"no {self.noun} has the id {q(id)}",
            object=self._obj(id),
            operation=operation,
        )

    def _version_required(self, id: Id, operation: str) -> CallToolResult:  # noqa: A002
        return not_applied(
            f"{self.version_arg} is required for this write to {self.noun} {q(id)}",
            code="version_required",
            message=f"the call did not carry {self.version_arg}",
            argument=pointer(self.version_arg),
            object=self._obj(id),
            operation=operation,
            read_with=self._read_with(id),
            notes=[
                f"Read {self.noun} {q(id)} with {q(self.read_tool)} and send the version it returns as {self.version_arg}, "
                "so that a change made since your read is not overwritten"
            ],
        )

    def _conflict(self, id: Id, current: Snapshot, operation: str) -> CallToolResult:  # noqa: A002
        state = {k: v for k, v in current.state.items() if k not in self.omit}
        return conflict(
            id,
            current_version=current.version,
            version_source=self.version_source,  # type: ignore[arg-type]
            current_state=state,
            omitted=[pointer(k) for k in self.omit if k in current.state],
            read_tool=self.read_tool,
            noun=self.noun,
            object_type=self.object_type,
            id_argument=self.id_argument,
            version_argument=self.version_arg,
            operation=operation,
        )

    def _receipt(self, id: Id, before: Snapshot, after: Snapshot | None, verb: str, operation: str) -> CallToolResult:  # noqa: A002
        # repeat "no": the usual value after applied (draft B-9). A repeat of a call that carried the version is
        # refused as a conflict, but "yes" is not given after a whole-value set or a delete.
        if after is None:
            return applied(f"{verb} {self.noun} {q(id)}", object=self._obj(id), operation=operation)
        ch = changed_fields(before.state, after.state, ignore=[*self.ignore, self.version_field])
        return applied(
            f"{verb} {self.noun} {q(id)}" if ch else f"{self.noun} {q(id)} already had these values",
            object=self._obj(id, after.version),
            changed=ch,
            operation=operation,
            data={self.data_key: dict(after.state)} if self.data_key else None,
        )

    def _error(self, id: Id, e: BaseException, expected: Version | None, what: str, operation: str) -> CallToolResult:  # noqa: A002
        if classify_error(e) == "not_applied":
            if isinstance(e, NotAppliedError):
                return not_applied(str(e), code=e.code, message=str(e), object=self._obj(id), operation=operation)
            return not_applied(
                "the backend could not be reached, so the request was not sent",
                code="not_sent",
                message="the connection to the backend could not be made",
                object=self._obj(id),
                operation=operation,
            )
        return unknown_outcome(
            f"the {what} of {self.noun} {q(id)} was sent and no answer arrived",
            read_with=self._read_with(id),
            object={"type": self.object_type, "id": id},
            operation=operation,
            # A repeat carrying the same version is refused as a conflict if the first call was applied,
            # provided the backend changes the version on every write it applies.
            guard=RepeatGuard(version=(self.version_arg, expected)) if expected is not None else None,
            cause=(str(e) or None) if isinstance(e, OutcomeUnknownError) else type(e).__name__,
        )

    # -- sync -----------------------------------------------------------------------------------

    def apply(self, id: Id, expected_version: Version | None, change: C, *, verb: str = "updated", what: str = "update", operation: str = "update") -> CallToolResult:  # noqa: A002
        """Compare, then write. Returns a receipt, a conflict, a refusal or an unknown outcome."""
        if inspect.iscoroutinefunction(self.read) or inspect.iscoroutinefunction(self.write):
            raise TypeError("read or write is async; use apply_async")
        if expected_version is None and self.require_version:
            return self._version_required(id, operation)
        with self._lock_for(id):
            current = self.read(id)
            if current is None:
                return self._missing(id, operation)
            if expected_version is not None and not _same_version(expected_version, current.version):
                return self._conflict(id, current, operation)
            try:
                after = self.write(id, change, expected_version)
            except VersionConflict as vc:
                now = vc.current or self.read(id)  # type: ignore[assignment]
                return self._conflict(id, now, operation) if now is not None else self._missing(id, operation)
            except Exception as e:  # noqa: BLE001
                return self._error(id, e, expected_version, what, operation)
            return self._receipt(id, current, after, verb, operation)

    def delete(self, id: Id, expected_version: Version | None) -> CallToolResult:  # noqa: A002
        """Compare, then delete (``write`` receives ``change=None`` and returns None)."""
        return self.apply(id, expected_version, None, verb="deleted", what="delete", operation="delete")  # type: ignore[arg-type]

    # -- async ----------------------------------------------------------------------------------

    async def apply_async(self, id: Id, expected_version: Version | None, change: C, *, verb: str = "updated", what: str = "update", operation: str = "update") -> CallToolResult:  # noqa: A002
        """The async form of :meth:`apply`; ``read`` and ``write`` may be sync or async."""
        if expected_version is None and self.require_version:
            return self._version_required(id, operation)
        lock = self._lock_for(id)
        await self._acquire_async(lock)
        try:
            current = await _maybe(self.read(id))
            if current is None:
                return self._missing(id, operation)
            if expected_version is not None and not _same_version(expected_version, current.version):
                return self._conflict(id, current, operation)
            try:
                after = await _maybe(self.write(id, change, expected_version))
            except VersionConflict as vc:
                now = vc.current or await _maybe(self.read(id))
                return self._conflict(id, now, operation) if now is not None else self._missing(id, operation)
            except Exception as e:  # noqa: BLE001
                return self._error(id, e, expected_version, what, operation)
            return self._receipt(id, current, after, verb, operation)
        finally:
            lock.release()

    async def delete_async(self, id: Id, expected_version: Version | None) -> CallToolResult:  # noqa: A002
        """The async form of :meth:`delete`."""
        return await self.apply_async(id, expected_version, None, verb="deleted", what="delete", operation="delete")  # type: ignore[arg-type]


async def _maybe(x: Any) -> Any:
    return await x if inspect.isawaitable(x) else x
