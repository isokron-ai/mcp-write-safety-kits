// @mcp-write-safety/kit: helpers for MCP write tools, for the MCP Write-Safety Requirements (MWS 0.9).
// Using the kit helps a server meet MWS; it does not make the server conformant. Only the tests decide.

export type { CallToolResult, TextContent, Tool, ToolAnnotations, MaybePromise } from "./types.js";

export {
  RESULT_SHAPE, RESULT_SCHEMA, q, renderText, assertShape, toToolResult, readResult,
  applied, notApplied, partial, conflict,
  type Outcome, type Id, type Version, type ObjectRef, type FailedItem, type ConflictInfo, type MwsResult, type TextOptions,
  type AppliedOptions, type NotAppliedOptions, type PartialOptions, type ConflictOptions,
} from "./result.js";

export {
  unknownOutcome, guardWrite, classifyError, NotAppliedError, OutcomeUnknownError,
  type UnknownOutcomeOptions, type RepeatGuard, type ErrorClass, type GuardWriteOptions,
} from "./outcome.js";

export {
  compareAndSet, KeyedMutex, VersionConflictError,
  type CompareAndSetOptions, type Current, type WriteReceipt,
} from "./version-check.js";

export {
  MemoryIdempotencyStore, withIdempotency, replayOf, REPLAY_META_KEY, canonicalJson, fingerprintOf, idempotencyKeyDescription, idempotencyKeyProperty,
  type IdempotencyStore, type BeginResult, type MemoryStoreOptions, type IdempotencyOptions, type KeyPropertyOptions,
} from "./idempotency.js";

export {
  strictInput, withStrictInput, validateArguments, inputError, describeIssue, closeSchema, assertSupportedSchema, jsonEqual,
  SchemaError, SUPPORTED_KEYWORDS,
  type JsonSchema, type JsonType, type InputIssue, type Validation, type StrictInput,
} from "./strict-input.js";

export {
  readOnlyHints, writeHints, annotationProblems,
  type ExplicitAnnotations, type ReadToolHints, type WriteToolHints,
} from "./annotations.js";

export {
  defineTool, ToolSet, UnknownToolError,
  type ToolSpec, type ReadToolSpec, type WriteToolSpec, type DefinedTool,
} from "./tool.js";
