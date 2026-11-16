"""Strict inputs: refuse unknown arguments and wrong types against the tool's own JSON Schema
(MWS-IN-1, IN-2, IN-3, IN-4, IN-6, IN-7).

Why this exists. The MCP Python SDK's high-level server (``FastMCP`` in 1.x, ``MCPServer`` in 2.x)
validates a tool's arguments with a pydantic model built from the function's signature, in pydantic's
default *lax* mode, and the model ignores arguments it does not define. So, by default:

- ``"true"`` and ``"yes"`` become ``True`` and ``"0"`` becomes ``False`` for a ``bool`` parameter,
  ``"5"`` becomes ``5`` for an ``int``, and ``5.0`` becomes ``5``;
- FastMCP 1.x also parses a string that holds JSON (``"[1, 2]"``) for a list or object parameter;
- a misspelled argument (``asignee``) is dropped without a word, and the call succeeds.

MWS-IN-1 forbids the conversions that change a value's meaning, MWS-IN-2 forbids dropping an
unknown argument silently, and MWS-IN-6 and IN-7 ask that both be refused. This module checks the
raw arguments, before the SDK sees them, against the tool's advertised schema with
``additionalProperties: false`` added, and refuses the call with a tool execution error that names
each argument at fault, what was expected and what was sent, and says nothing was changed.

The checker supports the JSON Schema keywords that pydantic and hand-written tool schemas use, and
refuses a schema with any other validation keyword (it never skips a constraint it does not know).
"""

from __future__ import annotations

import copy
import difflib
import functools
import math
import re
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from ._mcp import CallToolResult
from .result import not_applied, pointer, q

__all__ = [
    "ArgumentIssue",
    "UnsupportedSchema",
    "check_arguments",
    "strict_schema",
    "refuse_arguments",
    "SUPPORTED_KEYWORDS",
]

#: Keywords that validate and that the checker implements.
_VALIDATING = {
    "type", "enum", "const", "properties", "required", "additionalProperties", "items", "prefixItems",
    "minItems", "maxItems", "uniqueItems", "minLength", "maxLength", "pattern", "minimum", "maximum",
    "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minProperties", "maxProperties", "anyOf",
    "oneOf", "allOf", "$ref", "$defs", "definitions",
}
#: Keywords that do not validate (annotations), which the checker ignores.
_ANNOTATIONS = {
    "$schema", "$id", "$comment", "title", "description", "default", "examples", "deprecated", "readOnly",
    "writeOnly", "format", "contentMediaType", "contentEncoding", "discriminator",
}
SUPPORTED_KEYWORDS = frozenset(_VALIDATING | _ANNOTATIONS)


class UnsupportedSchema(ValueError):
    """The schema uses a validation keyword the checker does not implement."""


@dataclass(frozen=True)
class ArgumentIssue:
    """One reason an argument was refused.

    ``path`` is the argument's name, followed by list positions and nested keys
    (``["tags", 2]``, ``["details", "severity"]``). ``reason`` completes the sentence
    ``Argument "<path>": <reason>``.
    """

    path: tuple[str | int, ...]
    reason: str

    @property
    def argument(self) -> str:
        """The path written as ``tags[2]`` or ``details.severity``."""
        out = ""
        for p in self.path:
            out += f"[{p}]" if isinstance(p, int) else (f".{p}" if out else str(p))
        return out or "(arguments)"

    def sentence(self) -> str:
        return f"Argument {q(self.argument)}: {self.reason}"


# ------------------------------------------------------------------------------------------------
# Types


def _json_type(v: Any) -> str:
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "boolean"
    if isinstance(v, int):
        return "integer"
    if isinstance(v, float):
        return "number"
    if isinstance(v, str):
        return "string"
    if isinstance(v, (list, tuple)):
        return "array"
    if isinstance(v, Mapping):
        return "object"
    return type(v).__name__


def _is_type(v: Any, t: str) -> bool:
    actual = _json_type(v)
    if t == "number":
        return actual in ("integer", "number") and not (isinstance(v, float) and not math.isfinite(v))
    if t == "integer":
        return actual == "integer" or (isinstance(v, float) and math.isfinite(v) and v.is_integer())
    return actual == t


def _shown(v: Any, limit: int = 80) -> str:
    """The value as sent, typed, and cut to a readable length: 'string "abc"', 'number 0.5'."""
    try:
        text = q(v)
    except (TypeError, ValueError):
        text = repr(v)
    if len(text) > limit:
        text = text[: limit - 1] + "…"
    kind = _json_type(v)
    kind = "number" if kind == "integer" else kind
    return text if kind == "null" else f"{kind} {text}"


# ------------------------------------------------------------------------------------------------
# Patterns


_ECMA_ESCAPES = {"d": "[0-9]", "D": "[^0-9]", "w": "[A-Za-z0-9_]", "W": "[^A-Za-z0-9_]"}
_ECMA_CLASS_ESCAPES = {"d": "0-9", "w": "A-Za-z0-9_"}


@functools.lru_cache(maxsize=512)
def _pattern(source: str) -> re.Pattern[str]:
    """A JSON Schema ``pattern`` (ECMA-262) compiled for Python's ``re`` with the ECMA meaning of the
    constructs that differ in ways that matter for a check: ``$`` matches only at the very end
    (Python's also matches before a final newline, which would let ``"n-3\\n"`` through
    ``^n-[0-9]+$``), ``.`` matches no line terminator (``\\n``, ``\\r``, U+2028, U+2029), and
    ``\\d``/``\\w`` (and ``\\D``/``\\W``) are ASCII only. ``\\s`` keeps its Unicode meaning, as
    in ECMA-262. Raises :class:`UnsupportedSchema` for a pattern that does not compile."""
    out: list[str] = []
    i, in_class = 0, False
    while i < len(source):
        ch = source[i]
        if ch == "\\" and i + 1 < len(source):
            esc = source[i + 1]
            if in_class and esc in _ECMA_CLASS_ESCAPES:
                out.append(_ECMA_CLASS_ESCAPES[esc])
            elif not in_class and esc in _ECMA_ESCAPES:
                out.append(_ECMA_ESCAPES[esc])
            else:
                out.append(source[i : i + 2])
            i += 2
            continue
        if in_class:
            if ch == "]":
                in_class = False
        elif ch == "[":
            in_class = True
        elif ch == "$":
            out.append(r"(?:\Z)")
            i += 1
            continue
        elif ch == ".":
            out.append("[^\n\r\u2028\u2029]")
            i += 1
            continue
        out.append(ch)
        i += 1
    try:
        return re.compile("".join(out))
    except re.error as e:
        raise UnsupportedSchema(f"the pattern {source!r} does not compile: {e}") from None


# ------------------------------------------------------------------------------------------------
# Checking


class _Checker:
    def __init__(self, root: Mapping[str, Any]) -> None:
        self.root = root

    def resolve(self, schema: Mapping[str, Any]) -> Mapping[str, Any]:
        seen = 0
        while "$ref" in schema:
            ref = schema["$ref"]
            if not isinstance(ref, str) or not ref.startswith("#/"):
                raise UnsupportedSchema(f"only local references are supported, not {ref!r}")
            target: Any = self.root
            for part in ref[2:].split("/"):
                part = part.replace("~1", "/").replace("~0", "~")
                if not isinstance(target, Mapping) or part not in target:
                    raise UnsupportedSchema(f"reference {ref!r} does not resolve")
                target = target[part]
            extra = {k: v for k, v in schema.items() if k != "$ref"}
            schema = {**target, **extra} if extra else target
            seen += 1
            if seen > 32:
                raise UnsupportedSchema(f"reference {ref!r} does not end")
        return schema

    def check(self, schema: Any, value: Any, path: tuple[str | int, ...]) -> list[ArgumentIssue]:
        if schema is True or schema == {}:
            return []
        if schema is False:
            return [ArgumentIssue(path, f"is not allowed; got {_shown(value)}")]
        if not isinstance(schema, Mapping):
            raise UnsupportedSchema(f"a schema must be an object or a boolean, not {type(schema).__name__}")
        schema = self.resolve(schema)
        unknown = set(schema) - SUPPORTED_KEYWORDS
        unknown = {k for k in unknown if not k.startswith("x-")}
        if unknown:
            raise UnsupportedSchema(f"unsupported keyword(s) {sorted(unknown)} at {list(path) or 'the top level'}")

        for k in ("allOf",):
            if k in schema:
                out: list[ArgumentIssue] = []
                for sub in schema[k]:
                    out += self.check(sub, value, path)
                if out:
                    return out
        for k in ("anyOf", "oneOf"):
            if k in schema:
                alt = self._alternatives(schema, value, path, k)
                if alt:
                    return alt

        types = schema.get("type")
        if types is not None:
            allowed = [types] if isinstance(types, str) else list(types)
            if not any(_is_type(value, t) for t in allowed):
                return [ArgumentIssue(path, f"expected {' or '.join(allowed)}, got {_shown(value)}")]

        issues: list[ArgumentIssue] = []
        if "const" in schema and not _equal(value, schema["const"]):
            issues.append(ArgumentIssue(path, f"must be {q(schema['const'])}; got {_shown(value)}"))
        if "enum" in schema and not any(_equal(value, e) for e in schema["enum"]):
            members = ", ".join(q(e) for e in schema["enum"])
            issues.append(ArgumentIssue(path, f"must be one of {members}; got {_shown(value)}"))
        if issues:
            return issues

        if isinstance(value, str):
            n = len(value)
            if "minLength" in schema and n < schema["minLength"]:
                issues.append(ArgumentIssue(path, f"must be at least {schema['minLength']} characters long; got {n}"))
            if "maxLength" in schema and n > schema["maxLength"]:
                issues.append(ArgumentIssue(path, f"must be at most {schema['maxLength']} characters long; got {n}"))
            if "pattern" in schema and _pattern(schema["pattern"]).search(value) is None:
                issues.append(ArgumentIssue(path, f"must match the pattern {q(schema['pattern'])}; got {_shown(value)}"))
        if _json_type(value) in ("integer", "number"):
            if "minimum" in schema and value < schema["minimum"]:
                issues.append(ArgumentIssue(path, f"must be at least {q(schema['minimum'])}; got {_shown(value)}"))
            if "maximum" in schema and value > schema["maximum"]:
                issues.append(ArgumentIssue(path, f"must be at most {q(schema['maximum'])}; got {_shown(value)}"))
            if "exclusiveMinimum" in schema and value <= schema["exclusiveMinimum"]:
                issues.append(ArgumentIssue(path, f"must be greater than {q(schema['exclusiveMinimum'])}; got {_shown(value)}"))
            if "exclusiveMaximum" in schema and value >= schema["exclusiveMaximum"]:
                issues.append(ArgumentIssue(path, f"must be less than {q(schema['exclusiveMaximum'])}; got {_shown(value)}"))
            if "multipleOf" in schema:
                m = schema["multipleOf"]
                ratio = value / m
                if not math.isclose(ratio, round(ratio), rel_tol=0, abs_tol=1e-9):
                    issues.append(ArgumentIssue(path, f"must be a multiple of {q(m)}; got {_shown(value)}"))
        if isinstance(value, (list, tuple)):
            issues += self._array(schema, list(value), path)
        if isinstance(value, Mapping):
            issues += self._object(schema, value, path)
        return issues

    def _alternatives(self, schema: Mapping[str, Any], value: Any, path: tuple[str | int, ...], key: str) -> list[ArgumentIssue]:
        branches = [self.resolve(b) if isinstance(b, Mapping) else b for b in schema[key]]
        results = [self.check(b, value, path) for b in branches]
        passing = sum(1 for r in results if not r)
        if key == "anyOf" and passing >= 1:
            return []
        if key == "oneOf" and passing == 1:
            return []
        if key == "oneOf" and passing > 1:
            return [ArgumentIssue(path, f"matches more than one of the allowed forms; got {_shown(value)}")]
        # Report the branch whose type the value has; otherwise name every allowed type.
        typed = [r for b, r in zip(branches, results) if isinstance(b, Mapping) and "type" in b
                 and any(_is_type(value, t) for t in ([b["type"]] if isinstance(b["type"], str) else b["type"]))]
        if typed:
            return typed[0]
        names: list[str] = []
        for b in branches:
            if isinstance(b, Mapping) and "type" in b:
                for t in [b["type"]] if isinstance(b["type"], str) else b["type"]:
                    if t not in names:
                        names.append(t)
            elif isinstance(b, Mapping) and "const" in b:
                names.append(q(b["const"]))
            elif isinstance(b, Mapping) and "enum" in b:
                names.extend(q(e) for e in b["enum"])
        if names:
            return [ArgumentIssue(path, f"expected {' or '.join(names)}, got {_shown(value)}")]
        return results[0] if results else [ArgumentIssue(path, f"is not allowed; got {_shown(value)}")]

    def _array(self, schema: Mapping[str, Any], value: list[Any], path: tuple[str | int, ...]) -> list[ArgumentIssue]:
        issues: list[ArgumentIssue] = []
        n = len(value)
        if "minItems" in schema and n < schema["minItems"]:
            issues.append(ArgumentIssue(path, f"must have at least {schema['minItems']} items; got {n}"))
        if "maxItems" in schema and n > schema["maxItems"]:
            issues.append(ArgumentIssue(path, f"must have at most {schema['maxItems']} items; got {n}"))
        if schema.get("uniqueItems"):
            for i in range(n):
                if any(_equal(value[i], value[j]) for j in range(i)):
                    issues.append(ArgumentIssue(path, f"must not repeat an item; {_shown(value[i])} appears more than once"))
                    break
        prefix = schema.get("prefixItems") or []
        for i, item in enumerate(value):
            if i < len(prefix):
                issues += self.check(prefix[i], item, (*path, i))
            elif "items" in schema:
                issues += self.check(schema["items"], item, (*path, i))
        return issues

    def _object(self, schema: Mapping[str, Any], value: Mapping[str, Any], path: tuple[str | int, ...]) -> list[ArgumentIssue]:
        issues: list[ArgumentIssue] = []
        props: Mapping[str, Any] = schema.get("properties") or {}
        for name in schema.get("required") or []:
            if name not in value:
                issues.append(ArgumentIssue((*path, name), "is required and was not sent"))
        n = len(value)
        if "minProperties" in schema and n < schema["minProperties"]:
            issues.append(ArgumentIssue(path, f"must have at least {schema['minProperties']} properties; got {n}"))
        if "maxProperties" in schema and n > schema["maxProperties"]:
            issues.append(ArgumentIssue(path, f"must have at most {schema['maxProperties']} properties; got {n}"))
        extra = schema.get("additionalProperties", True)
        for name, item in value.items():
            if name in props:
                issues += self.check(props[name], item, (*path, name))
            elif extra is False:
                hint = difflib.get_close_matches(str(name), list(props), n=1, cutoff=0.75)
                where = "this tool" if not path else "this object"
                reason = f"is not an argument of {where} and was not used"
                if hint:
                    reason += f" (did you mean {q(hint[0])}?)"
                issues.append(ArgumentIssue((*path, name), reason))
            elif isinstance(extra, Mapping):
                issues += self.check(extra, item, (*path, name))
        return issues


def _equal(a: Any, b: Any) -> bool:
    # JSON equality: true is not 1, 1 is 1.0.
    if isinstance(a, bool) or isinstance(b, bool):
        return isinstance(a, bool) and isinstance(b, bool) and a == b
    return a == b


def check_arguments(schema: Mapping[str, Any], arguments: Any) -> list[ArgumentIssue]:
    """Checks a call's arguments against a tool's input schema, strictly: no conversion of any kind.

    Returns the issues, or an empty list. Raises :class:`UnsupportedSchema` if the schema uses a
    validation keyword the checker does not implement.
    """
    if not isinstance(arguments, Mapping):
        return [ArgumentIssue((), f"the arguments must be an object; got {_shown(arguments)}")]
    return _Checker(schema).check(schema, arguments, ())


def strict_schema(schema: Mapping[str, Any]) -> dict[str, Any]:
    """A copy of ``schema`` in which every object schema that does not say otherwise has
    ``additionalProperties: false`` (MWS-IN-2 guidance: the schema shows the rule the tool applies).

    Also checks that the checker supports every keyword in it (:class:`UnsupportedSchema`).
    """
    out = copy.deepcopy(dict(schema))

    def walk(node: Any) -> None:
        if isinstance(node, dict):
            if ("properties" in node or node.get("type") == "object") and "additionalProperties" not in node:
                node["additionalProperties"] = False
            for k, v in node.items():
                if k in ("properties", "$defs", "definitions"):
                    for sub in v.values():
                        walk(sub)
                elif k in ("items", "additionalProperties"):
                    walk(v)
                elif k in ("anyOf", "oneOf", "allOf", "prefixItems"):
                    for sub in v:
                        walk(sub)
        elif isinstance(node, list):
            for sub in node:
                walk(sub)

    walk(out)
    _validate_keywords(out, ())
    return out


def _validate_keywords(node: Any, path: tuple[str, ...]) -> None:
    if not isinstance(node, Mapping):
        return
    unknown = {k for k in node if k not in SUPPORTED_KEYWORDS and not k.startswith("x-")}
    where = "/".join(path) or "the top level"
    if unknown:
        raise UnsupportedSchema(f"unsupported keyword(s) {sorted(unknown)} at {where}")
    if "pattern" in node:
        if not isinstance(node["pattern"], str):
            raise UnsupportedSchema(f"pattern at {where} is not a string")
        _pattern(node["pattern"])
    for k in ("minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"):
        if k in node and (isinstance(node[k], bool) or not isinstance(node[k], (int, float)) or not math.isfinite(node[k])):
            raise UnsupportedSchema(f"{k} at {where} must be a finite number (draft-04 boolean forms are not supported)")
    for k in ("minLength", "maxLength", "minItems", "maxItems", "minProperties", "maxProperties"):
        if k in node and (isinstance(node[k], bool) or not isinstance(node[k], int) or node[k] < 0):
            raise UnsupportedSchema(f"{k} at {where} must be a non-negative integer")
    if "required" in node and not (isinstance(node["required"], list) and all(isinstance(r, str) for r in node["required"])):
        raise UnsupportedSchema(f"required at {where} must be a list of strings")
    if "$ref" in node and not (isinstance(node["$ref"], str) and node["$ref"].startswith("#/")):
        raise UnsupportedSchema(f"only local references are supported, not {node['$ref']!r} at {where}")
    for k, v in node.items():
        if k in ("properties", "$defs", "definitions") and isinstance(v, Mapping):
            for name, sub in v.items():
                _validate_keywords(sub, (*path, k, name))
        elif k in ("items", "additionalProperties"):
            _validate_keywords(v, (*path, k))
        elif k in ("anyOf", "oneOf", "allOf", "prefixItems") and isinstance(v, Sequence):
            for i, sub in enumerate(v):
                _validate_keywords(sub, (*path, k, str(i)))


def refuse_arguments(tool: str, issues: Iterable[ArgumentIssue]) -> CallToolResult:
    """The tool execution error for refused arguments (MWS-IN-4): ``code: "invalid_argument"``,
    ``argument`` (a JSON Pointer to the first argument at fault) and ``message``; the text names
    every argument at fault, what was expected and what was sent, and says nothing was changed.

    Shape 0.1 has one ``argument`` per result. Where several arguments are refused, the first is
    named there and every one is named in the text.
    """
    issues = list(issues)
    first = issues[0] if issues else ArgumentIssue((), "was refused")
    return not_applied(
        f"the arguments of {q(tool)} were refused",
        code="invalid_argument",
        message=first.sentence() + (f" (and {len(issues) - 1} more)" if len(issues) > 1 else ""),
        argument=pointer(*first.path),
        notes=[i.sentence() for i in issues[1:]],
    )
