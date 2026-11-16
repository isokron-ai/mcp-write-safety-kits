"""Unknown outcomes (MWS-RES-2).

When a write was sent to the backend and its answer was lost (a timeout, a closed or reset
connection), the server does not know whether the write was applied. Saying that it failed invites a
retry and a duplicate; saying that it succeeded may be false. The truthful answer is a tool
execution error that says the outcome is unknown, names the read that settles it, and says whether
the same call is safe to send again. The spec allows an invitation to repeat only after the named
read, or with the idempotency key or the version that the call carried.
"""

from __future__ import annotations

import errno
import inspect
import socket
from collections.abc import Awaitable, Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Literal

from ._mcp import CallToolResult
from .result import ReadWith, not_applied, to_tool_result

__all__ = [
    "RepeatGuard",
    "NotAppliedError",
    "OutcomeUnknownError",
    "ErrorClass",
    "classify_error",
    "unknown_code",
    "unknown_outcome",
    "guard_write",
    "guard_write_async",
]


@dataclass(frozen=True)
class RepeatGuard:
    """What guards a repeat of the same call: the idempotency key or the version it carried.

    Give ``idempotency_key`` as ``(argument name, value)`` only where the server honours the key
    (MWS-RETRY-2), and ``version`` as ``(argument name, value)`` only where a write with a stale
    version is refused (MWS-CONC-2).
    """

    idempotency_key: tuple[str, str] | None = None
    version: tuple[str, str | int] | None = None


class NotAppliedError(Exception):
    """Raised by a write callable when the backend refused the write: nothing was applied.

    ``code`` is the shape's ``code`` for the refusal (``"locked"``, or one of the server's own).
    Its message is written for the caller and is copied into the result, so never put a request,
    a URL with a token or other credentials in it (MWS-SEC-1).
    """

    def __init__(self, message: str, *, code: str | None = None, object: Mapping[str, Any] | None = None) -> None:  # noqa: A002
        super().__init__(message)
        self.code = code
        self.object = object


class OutcomeUnknownError(Exception):
    """Raised by a write callable when the request may have reached the backend and no answer arrived.

    Its message is copied into the result as the cause: keep it short ("timeout after 30 s") and
    free of credentials.
    """


ErrorClass = Literal["not_applied", "unknown"]

# Errors that mean the request was not sent: the connection was never made.
_NOT_SENT_ERRNOS = {errno.ECONNREFUSED, errno.EHOSTUNREACH, errno.ENETUNREACH}
_NOT_SENT_NAMES = {
    # httpx / httpcore: a connection that was never established.
    "ConnectError",
    "ConnectTimeout",
    "UnsupportedProtocol",
    "InvalidURL",
    # aiohttp
    "ClientConnectorError",
    "InvalidURL",
    # requests / urllib3
    "NewConnectionError",
    "NameResolutionError",
}


# Errors that mean the request may have been sent and its answer was lost.
_LOST_ANSWER_NAMES = {
    # httpx / httpcore
    "ReadTimeout",
    "WriteTimeout",
    "PoolTimeout",
    "ReadError",
    "WriteError",
    "RemoteProtocolError",
    # aiohttp
    "ServerDisconnectedError",
    "ServerTimeoutError",
    "ClientPayloadError",
    # requests / urllib3
    "ReadTimeoutError",
    "ProtocolError",
}


def _is_lost_answer(e: BaseException) -> bool:
    if isinstance(e, OutcomeUnknownError):
        return True
    if isinstance(e, (TimeoutError, ConnectionResetError, ConnectionAbortedError, BrokenPipeError)):
        return True
    return any(c.__name__ in _LOST_ANSWER_NAMES for c in type(e).__mro__)


def unknown_code(e: BaseException) -> str:
    """The ``code`` for an unknown outcome caused by ``e``: ``"no_answer"`` (fixed by the draft:
    a request was sent and no answer arrived) only where the error says so (a timeout, a reset or
    closed connection, :class:`OutcomeUnknownError`), anywhere in its ``__cause__`` chain;
    otherwise ``"internal_error"`` (a server code: the handler failed after it may have written)."""
    cur: BaseException | None = e
    for _ in range(6):
        if cur is None:
            break
        if _is_lost_answer(cur):
            return "no_answer"
        cur = cur.__cause__
    return "internal_error"


def classify_error(e: BaseException) -> ErrorClass:
    """How an error raised while sending a write bears on it.

    ``"not_applied"``: the backend refused it (:class:`NotAppliedError`), or the request was never
    sent (connection refused, name not resolved, a connect error of httpx, aiohttp or urllib3;
    requests wraps its errors without an explicit cause, so they read as unknown):
    the outcome is settled and nothing was applied.

    ``"unknown"``: the request may have been sent and no answer arrived (a read timeout, a reset
    connection), or the error is not recognised. This is the cautious reading: never report
    "failed" when unsure.

    The chain is followed through ``__cause__`` only (``raise ... from ...``), outermost first, and
    stops at the first error that says the answer was lost. ``__context__`` (an error raised while
    another was being handled) is not followed: a timeout raised during the handling of a refused
    connection, as in a fallback or an internal retry, is a request that may have been sent.
    """
    cur: BaseException | None = e
    for _ in range(5):
        if cur is None:
            break
        if isinstance(cur, NotAppliedError):
            return "not_applied"
        if isinstance(cur, OutcomeUnknownError):
            return "unknown"
        if isinstance(cur, (ConnectionRefusedError, socket.gaierror)):
            return "not_applied"
        if isinstance(cur, OSError) and cur.errno in _NOT_SENT_ERRNOS:
            return "not_applied"
        if any(c.__name__ in _NOT_SENT_NAMES for c in type(cur).__mro__):
            return "not_applied"
        if _is_lost_answer(cur):
            return "unknown"
        cur = cur.__cause__
    return "unknown"


def unknown_outcome(
    summary: str,
    *,
    read_with: ReadWith | Mapping[str, Any],
    object: Mapping[str, Any] | None = None,  # noqa: A002
    guard: RepeatGuard | None = None,
    cause: str | None = None,
    code: str = "no_answer",
    operation: str | None = None,
    items: Sequence[Mapping[str, Any]] | None = None,
    notes: Iterable[str] = (),
) -> CallToolResult:
    """A tool execution error that says the outcome is unknown (MWS-RES-2).

    ``summary`` says what was sent, without a final period, e.g.
    ``'the update to note "n-3" was sent and no answer arrived'``. ``read_with`` is the read that
    shows whether the write took effect (:func:`mws_kit.read_with`). Without a ``guard``,
    ``repeat`` is ``"read_first"``; with an idempotency key it is ``"same_key"``, with a version
    ``"same_version"``. Never ``"yes"``: that would invite a blind repeat of an open write.
    ``items`` gives the parts whose outcome is known, where the call had several.
    """
    out: list[str] = []
    if cause:
        out.append(f"Cause: {cause}")
    if guard is not None and guard.idempotency_key is not None:
        repeat, key, ver = "same_key", guard.idempotency_key, None
    elif guard is not None and guard.version is not None:
        repeat, key, ver = "same_version", None, guard.version
    else:
        repeat, key, ver = "read_first", None, None
    obj = None if object is None else {k: str(v) for k, v in object.items() if v is not None}
    return to_tool_result(
        {
            "outcome": "unknown",
            "repeat": repeat,
            "operation": operation,
            "object": obj,
            "items": [dict(i) for i in items] if items is not None else None,
            "code": code,
            "read_with": {"tool": read_with["tool"], "arguments": dict(read_with.get("arguments") or {})},
        },
        summary,
        [*out, *notes],
        key=key,
        version=ver,
    )


def _from_error(
    e: BaseException,
    *,
    read_with: ReadWith | Mapping[str, Any],
    what: str,
    object: Mapping[str, Any] | None,  # noqa: A002
    guard: RepeatGuard | None,
) -> CallToolResult:
    if classify_error(e) == "not_applied":
        if isinstance(e, NotAppliedError):
            return not_applied(str(e), code=e.code, message=str(e), object=e.object if e.object is not None else object)
        return not_applied(
            "the backend could not be reached, so the request was not sent",
            code="not_sent",
            message="the connection to the backend could not be made",
            object=object,
        )
    if isinstance(e, OutcomeUnknownError):
        cause: str | None = str(e) or None
    else:
        cause = type(e).__name__
    return unknown_outcome(what, read_with=read_with, object=object, guard=guard, cause=cause, code=unknown_code(e))


def guard_write(
    write: Callable[[], CallToolResult],
    *,
    read_with: ReadWith | Mapping[str, Any],
    what: str,
    object: Mapping[str, Any] | None = None,  # noqa: A002
    guard: RepeatGuard | None = None,
) -> CallToolResult:
    """Runs a write and turns a raised error into a truthful result.

    A refusal or an unsent request becomes "not applied"; anything else becomes "outcome unknown"
    naming the read that settles it (``read_with``). An error's message is not copied into the result unless it is
    a :class:`NotAppliedError` or :class:`OutcomeUnknownError`, whose messages the caller wrote for
    this purpose (a raw client error can carry a URL with a token, MWS-SEC-1); otherwise only the
    exception's class name is given as the cause.
    """
    try:
        return write()
    except Exception as e:  # noqa: BLE001 - every error becomes a truthful result
        return _from_error(e, read_with=read_with, what=what, object=object, guard=guard)


async def guard_write_async(
    write: Callable[[], Awaitable[CallToolResult] | CallToolResult],
    *,
    read_with: ReadWith | Mapping[str, Any],
    what: str,
    object: Mapping[str, Any] | None = None,  # noqa: A002
    guard: RepeatGuard | None = None,
) -> CallToolResult:
    """The async form of :func:`guard_write`; ``write`` may be sync or async."""
    try:
        r = write()
        if inspect.isawaitable(r):
            r = await r
        return r  # type: ignore[return-value]
    except Exception as e:  # noqa: BLE001
        return _from_error(e, read_with=read_with, what=what, object=object, guard=guard)
