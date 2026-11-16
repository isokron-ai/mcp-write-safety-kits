"""Integration with the MCP Python SDK's high-level server: ``FastMCP`` (SDK 1.x) or ``MCPServer``
(SDK 2.x).

:class:`WriteSafety` registers tools on the server with all four annotation hints and an
``outputSchema``, and for every call to one of its tools:

- checks the raw arguments against the tool's strict schema before the SDK converts them
  (:mod:`mws_kit.strict`), and refuses with ``invalid_argument`` or ``version_required``;
- checks a returned write result against the shape (:func:`mws_kit.assert_shape`) and fails closed:
  a malformed result becomes ``unknown`` with ``code: "internal_error"``, never a malformed answer;
- turns an exception that escapes a write handler into a truthful result instead of the SDK's
  bare "Error executing tool" text (MWS-RES-2).

How it hooks in:

- **SDK 2.x**: through the server's public middleware chain (``server.middleware``), which sees
  every ``tools/call`` before the SDK validates it. The SDK marks it provisional. A call made
  in-process with ``server.call_tool(...)`` does not pass through middleware. Here the kit sees an
  escaping exception only as the SDK's error text, so it reports it as ``internal_error`` (or
  ``invalid_argument`` where the SDK's own validation refused the call).
- **SDK 1.x** (no middleware): by wrapping ``call_tool`` on the server's tool manager
  (``server._tool_manager``), a private attribute. If it is missing, the kit refuses to start
  (:class:`IntegrationError`) rather than run without its checks. Here the kit sees the exception
  itself: :class:`mws_kit.NotAppliedError` and an unsent request become ``not_applied``,
  :class:`mws_kit.OutcomeUnknownError` ``no_answer``, anything else ``internal_error``.

Registration uses the tool manager on both lines (to publish the strict input schema and the
output schema on the registered tool).

For a low-level ``Server`` with your own ``call_tool`` handler, use the parts directly:
:func:`mws_kit.check_arguments` and :func:`mws_kit.refuse_arguments` before your handler,
:func:`mws_kit.strict_schema` for the advertised schema, :func:`mws_kit.output_schema`, and
:mod:`mws_kit.annotations` for the hints.
"""

from __future__ import annotations

import inspect
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any, Literal, TypeVar

from . import annotations as ann
from ._mcp import CallToolResult, ToolAnnotations, structured_of
from .result import ShapeError, assert_shape, not_applied, q
from .schema import output_schema as _output_schema
from .strict import check_arguments, refuse_arguments, strict_schema
from .unknown import NotAppliedError, OutcomeUnknownError, refusal_result, unknown_code, unknown_outcome

try:  # SDK 2.x
    from mcp.shared.exceptions import MCPError as _ProtocolError  # type: ignore[attr-defined,unused-ignore]
except ImportError:  # SDK 1.x
    from mcp.shared.exceptions import McpError as _ProtocolError  # type: ignore[no-redef,attr-defined]

__all__ = ["WriteSafety", "IntegrationError", "ToolSpec"]

F = TypeVar("F", bound=Callable[..., Any])


class IntegrationError(RuntimeError):
    """The server object does not offer what the kit hooks into."""


@dataclass
class ToolSpec:
    """What the kit keeps for a tool it registered."""

    name: str
    kind: Literal["read", "write"]
    schema: dict[str, Any]
    strict: bool
    read_tool: str | None
    read_arguments: dict[str, str]
    version_argument: str | None
    #: The tool advertises an outputSchema that requires ``mws``.
    shaped: bool = False


def _cause_chain(e: BaseException) -> list[BaseException]:
    # Explicit chaining only (``raise ... from ...``), as the SDK wraps a handler's error.
    out: list[BaseException] = []
    cur: BaseException | None = e
    while cur is not None and len(out) < 6:
        out.append(cur)
        cur = cur.__cause__
    return out


def _sdk_argument_error(tool: Any, arguments: Mapping[str, Any]) -> str | None:
    """Runs the SDK's own argument validation (``pre_parse_json`` then ``arg_model``) before the
    handler, as both SDK lines do inside ``call_tool``. Returns the first line of the error where
    the SDK would refuse the arguments, else None. Done here, before anything runs, so that a
    ValidationError raised later (inside the handler, or while the SDK converts its return value)
    is never taken for a refusal of the arguments: by then the write may have been made."""
    meta = getattr(tool, "fn_metadata", None)
    model = getattr(meta, "arg_model", None)
    if model is None:
        return None
    try:
        data = dict(arguments)
        pre = getattr(meta, "pre_parse_json", None)
        model.model_validate(pre(data) if callable(pre) else data)
    except Exception as e:  # noqa: BLE001 - the SDK raises pydantic's ValidationError
        return str(e).splitlines()[0] if str(e) else type(e).__name__
    return None


class WriteSafety:
    """The kit, attached to one server.

    ::

        server = MCPServer("notes")          # or FastMCP("notes") on SDK 1.x
        kit = WriteSafety(server)

        @kit.read_tool(open_world=False)
        def get_note(id: str) -> CallToolResult: ...

        @kit.write_tool(read_tool="get_note", read_arguments={"id": "id"}, version_argument="expected_version")
        def update_note(id: str, expected_version: int, title: str | None = None) -> CallToolResult: ...

    :param server: a ``FastMCP`` (SDK 1.x) or ``MCPServer`` (SDK 2.x) instance.
    :param strict: check each kit tool's raw arguments strictly (the default). With False, the
        SDK's own lax conversion applies (see :mod:`mws_kit.strict`).
    :param hook: ``"auto"`` (middleware where the server has it, else the tool manager),
        ``"middleware"`` or ``"tool_manager"``.
    """

    def __init__(self, server: Any, *, strict: bool = True, hook: Literal["auto", "middleware", "tool_manager"] = "auto") -> None:
        self.server = server
        self.strict = strict
        self.specs: dict[str, ToolSpec] = {}
        tm = getattr(server, "_tool_manager", None)
        if tm is None or not callable(getattr(tm, "call_tool", None)) or not callable(getattr(tm, "get_tool", None)):
            raise IntegrationError(
                "this server has no _tool_manager with call_tool and get_tool; the kit supports the MCP Python SDK's "
                "FastMCP (1.x) and MCPServer (2.x). For a low-level Server, call check_arguments() in your handler."
            )
        if getattr(tm, "_mws_kit", None) is not None:
            raise IntegrationError("a WriteSafety is already attached to this server")
        self._tm = tm
        chain = getattr(server, "middleware", None)
        use_mw = isinstance(chain, list) if hook == "auto" else hook == "middleware"
        if use_mw:
            if not isinstance(chain, list):
                raise IntegrationError("this server has no middleware list (SDK 2.x MCPServer.middleware)")
            chain.append(self._middleware)
            self.hook: str = "middleware"
        else:
            self._original = tm.call_tool
            tm.call_tool = self._call_tool
            self.hook = "tool_manager"
        tm._mws_kit = self

    # -- registration ---------------------------------------------------------------------------

    def _register(
        self,
        fn: Callable[..., Any],
        *,
        kind: Literal["read", "write"],
        annotations: ToolAnnotations,
        name: str | None,
        title: str | None,
        description: str | None,
        input_schema: Mapping[str, Any] | None,
        read_tool: str | None,
        read_arguments: Mapping[str, str] | None,
        version_argument: str | None,
        output: Mapping[str, Any] | None | bool,
    ) -> None:
        tool_name = name or fn.__name__
        if self._tm.get_tool(tool_name) is not None:
            raise IntegrationError(f"a tool named {tool_name!r} is already registered")
        kwargs: dict[str, Any] = {"name": tool_name, "description": description, "annotations": annotations}
        if title is not None:
            kwargs["title"] = title
        self.server.add_tool(fn, **kwargs)
        tool = self._tm.get_tool(tool_name)
        if tool is None:  # pragma: no cover - SDK contract
            raise IntegrationError(f"the SDK did not register {tool_name!r}")
        schema = strict_schema(input_schema if input_schema is not None else tool.parameters)
        if self.strict or input_schema is not None:
            tool.parameters = schema
        if output is not False:
            self._set_output_schema(tool, _output_schema(None if output is True else output))  # type: ignore[arg-type]
        self.specs[tool_name] = ToolSpec(
            tool_name, kind, schema, self.strict, read_tool, dict(read_arguments or {}), version_argument,
            shaped=output is not False,
        )

    @staticmethod
    def _set_output_schema(tool: Any, schema: dict[str, Any]) -> None:
        """Advertise ``schema`` as the tool's ``outputSchema``.

        Both SDK lines publish ``tool.fn_metadata.output_schema``. SDK 1.x also validates a returned
        ``CallToolResult`` against ``fn_metadata.output_model`` whenever a schema is set, so the kit
        gives it a model that accepts any object (the kit checks the shape itself).
        """
        meta = tool.fn_metadata
        meta.output_schema = schema
        if "output_model" in type(meta).model_fields and getattr(meta, "output_model", None) is None:
            try:  # SDK 1.x asserts that a model exists whenever a schema does
                from mcp.server.fastmcp.utilities.func_metadata import FuncMetadata  # type: ignore[import-not-found]  # noqa: F401

                meta.output_model = _AnyObject
            except ImportError:  # SDK 2.x: a schema without a model is published and not validated
                pass
        tool.__dict__.pop("output_schema", None)  # a cached_property in SDK 2.x

    def read_tool(
        self,
        *,
        open_world: bool = True,
        name: str | None = None,
        title: str | None = None,
        description: str | None = None,
        input_schema: Mapping[str, Any] | None = None,
    ) -> Callable[[F], F]:
        """Registers a tool that does not change state, with ``readOnlyHint: true`` and the other
        three hints explicit (MWS-ANN-1, ANN-4). Its input refusals carry the shape
        (``not_applied``), as B-9 allows for a read tool; its answers do not."""

        def deco(fn: F) -> F:
            self._register(
                fn,
                kind="read",
                annotations=ann.read_only(open_world=open_world),
                name=name,
                title=title,
                description=description,
                input_schema=input_schema,
                read_tool=None,
                read_arguments=None,
                version_argument=None,
                output=False,
            )
            return fn

        return deco

    def write_tool(
        self,
        *,
        read_tool: str,
        read_arguments: Mapping[str, str] | None = None,
        version_argument: str | None = None,
        destructive: bool = True,
        idempotent: bool = False,
        open_world: bool = True,
        output: Mapping[str, Any] | None | bool = None,
        name: str | None = None,
        title: str | None = None,
        description: str | None = None,
        input_schema: Mapping[str, Any] | None = None,
    ) -> Callable[[F], F]:
        """Registers a tool that can change state.

        The hints start at the cautious values (``destructiveHint: true``, ``idempotentHint: false``,
        ``openWorldHint: true``); relax one only where the tool's behaviour bears it out
        (MWS-ANN-2, ANN-3).

        - ``read_tool`` (required) is the read that shows whether a write took effect, and
          ``read_arguments`` maps the read's arguments to this tool's (``{"id": "id"}``). An
          exception that escapes the handler becomes an unknown outcome whose ``read_with`` names
          that read with the call's values (MWS-RES-2).
        - ``version_argument``: the argument that takes the version. A call without it is refused
          with ``version_required`` (in place of ``invalid_argument``) where the schema requires it.
        - ``output``: the schema of the tool's own output beside ``mws`` (an object schema), or
          None for a tool that returns only the shape. The advertised ``outputSchema`` requires
          ``mws`` always and the tool's own members only on ``applied``. False advertises none.
        """

        def deco(fn: F) -> F:
            self._register(
                fn,
                kind="write",
                annotations=ann.write(destructive=destructive, idempotent=idempotent, open_world=open_world),
                name=name,
                title=title,
                description=description,
                input_schema=input_schema,
                read_tool=read_tool,
                read_arguments=read_arguments,
                version_argument=version_argument,
                output=output,
            )
            return fn

        return deco

    # -- checks ---------------------------------------------------------------------------------

    def missing_hints(self) -> dict[str, list[str]]:
        """Every tool on the server (the kit's or not) that leaves an annotation hint to its default."""
        return ann.missing_hints(self._tm.list_tools())

    def unchecked_tools(self) -> list[str]:
        """Tools on the server that the kit did not register, whose arguments it does not check."""
        return sorted(t.name for t in self._tm.list_tools() if t.name not in self.specs)

    # -- shared steps ---------------------------------------------------------------------------

    def _refusal(self, spec: ToolSpec, arguments: Any) -> CallToolResult | None:
        if not spec.strict:
            return None
        issues = check_arguments(spec.schema, arguments if arguments is not None else {})
        return refuse_arguments(spec.name, issues, version_argument=spec.version_argument) if issues else None

    def _sdk_refusal(self, spec: ToolSpec, arguments: Any) -> CallToolResult | None:
        """The SDK's own argument validation, run before the handler (see _sdk_argument_error)."""
        refused = _sdk_argument_error(self._tm.get_tool(spec.name), arguments if isinstance(arguments, Mapping) else {})
        if refused is None:
            return None
        # The SDK would refuse these arguments before the handler runs: nothing was called.
        return not_applied(
            f"the arguments of {q(spec.name)} were refused",
            code="invalid_argument",
            message=refused,
        )

    def _read_with(self, spec: ToolSpec, arguments: Mapping[str, Any]) -> dict[str, Any]:
        rargs = {k: arguments[v] for k, v in spec.read_arguments.items() if v in arguments}
        return {"tool": spec.read_tool or spec.name, "arguments": rargs}

    def _checked(self, spec: ToolSpec, arguments: Mapping[str, Any], structured: Any, is_error: bool = False) -> CallToolResult | None:
        """None where the result is fine; else the fail-closed replacement (the handler ran and
        may have written, and its answer cannot be trusted)."""
        if spec.kind != "write":
            return None
        if not (isinstance(structured, Mapping) and "mws" in structured):
            if spec.shaped and not is_error:
                # A success without the shape, from a tool whose outputSchema requires it: a client
                # that validates results would reject it whole, and it says nothing of the write.
                return unknown_outcome(
                    f"{q(spec.name)} returned a result without the write-result shape after it may have written",
                    read_with=self._read_with(spec, arguments),
                    code="internal_error",
                    cause="the result did not carry write-result/0.1",
                )
            return None
        try:
            assert_shape(structured)
        except ShapeError:
            return unknown_outcome(
                f"{q(spec.name)} produced a malformed result after it may have written",
                read_with=self._read_with(spec, arguments),
                code="internal_error",
                cause="the result did not conform to write-result/0.1",
            )
        return None

    # -- SDK 2.x: middleware --------------------------------------------------------------------

    async def _middleware(self, ctx: Any, call_next: Callable[[Any], Any]) -> Any:
        params = getattr(ctx, "params", None)
        if getattr(ctx, "method", None) != "tools/call" or not isinstance(params, Mapping):
            return await call_next(ctx)
        spec = self.specs.get(params.get("name"))  # type: ignore[arg-type]
        if spec is None:
            return await call_next(ctx)
        arguments = params.get("arguments") or {}
        refusal = self._refusal(spec, arguments) or self._sdk_refusal(spec, arguments)
        if refusal is not None:
            return refusal
        result = await call_next(ctx)
        if not isinstance(result, Mapping) or result.get("resultType", "complete") != "complete":
            return result
        structured = result.get("structuredContent")
        replaced = self._checked(spec, arguments, structured, bool(result.get("isError")))
        if replaced is not None:
            return replaced
        if spec.kind == "write" and result.get("isError") and not (isinstance(structured, Mapping) and "mws" in structured):
            # The arguments passed the SDK's own validation before the call (_sdk_refusal), so an
            # error here, a ValidationError included, came from the handler or from converting
            # what it returned: the write may have been made. Never "not applied" from the text.
            return unknown_outcome(
                f"{q(spec.name)} stopped with an error after it may have written",
                read_with=self._read_with(spec, arguments),
                code="internal_error",
            )
        return result

    # -- SDK 1.x: the tool manager --------------------------------------------------------------

    async def _call_tool(self, name: str, arguments: dict[str, Any] | None, *args: Any, **kwargs: Any) -> Any:
        spec = self.specs.get(name)
        if spec is None:
            return await self._original(name, arguments, *args, **kwargs)
        refusal = self._refusal(spec, arguments) or self._sdk_refusal(spec, arguments)
        if refusal is not None:
            return refusal
        try:
            result = self._original(name, arguments, *args, **kwargs)
            result = await result if inspect.isawaitable(result) else result
        except _ProtocolError:
            raise
        except Exception as e:  # noqa: BLE001
            if spec.kind != "write":
                raise
            return self._write_failure(spec, e, arguments or {})
        if isinstance(result, CallToolResult):
            replaced = self._checked(spec, arguments or {}, structured_of(result), bool(getattr(result, "isError", None) or getattr(result, "is_error", None)))
            if replaced is not None:
                return replaced
        return result

    def _write_failure(self, spec: ToolSpec, e: BaseException, arguments: Mapping[str, Any]) -> CallToolResult:
        # The arguments passed the SDK's validation before the call (_call_tool), so an error here,
        # a ValidationError included, came from the handler or from converting what it returned:
        # the write may have been made.
        chain = _cause_chain(e)
        root = chain[-1]
        for c in chain:
            if isinstance(c, (NotAppliedError, OutcomeUnknownError)):
                root = c
                break
        refused = refusal_result(e, read_with=self._read_with(spec, arguments))
        if refused is not None:
            return refused
        return unknown_outcome(
            f"{q(spec.name)} stopped with an error after it may have written",
            read_with=self._read_with(spec, arguments),
            code=unknown_code(e),
            cause=str(root) if isinstance(root, OutcomeUnknownError) and str(root) else type(root).__name__,
        )

try:
    from pydantic import BaseModel, ConfigDict

    class _AnyObject(BaseModel):
        """Accepts any object (SDK 1.x needs a model wherever an output schema is set)."""

        model_config = ConfigDict(extra="allow")
except ImportError:  # pragma: no cover - pydantic comes with the MCP SDK
    _AnyObject = None  # type: ignore[assignment,misc]
