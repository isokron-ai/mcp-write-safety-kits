// The JSON Schema of the write-result shape, version 0.1 (MWS 0.9, Annex B, B-9), and a helper
// that builds a write tool's outputSchema as B-9 advises: `mws` required, the tool's own output
// members required only when `outcome` is "applied" (valid whether or not error results must
// conform; MCP issue 569), the shape's schema inlined rather than referenced remotely, and never
// `additionalProperties: false` on `mws` or its members.
//
// The same schema ships as schema/write-result-0.1.schema.json (a test checks that they agree).
// That file is CC BY 4.0, like the spec it comes from, and is byte-identical to the Python kit's copy
// and to the spec's spec/shapes/write-result-0.1.schema.json.

const STRING = { type: "string" } as const;
const POINTER = { type: "string", pattern: "^(/.*)?$" } as const;
const CODE = { type: "string", pattern: "^[a-z0-9_]+$" } as const;
const IDV = { $ref: "#/$defs/idv" } as const;

/** The JSON Schema (2020-12) of `structuredContent.mws`, write-result/0.1. */
export const WRITE_RESULT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $comment: "CC BY 4.0. MCP Write-Safety Requirements 0.9, Annex B, B-9.",
  title: "write-result 0.1 (MWS 0.9, Annex B, B-9)",
  description: "The value of structuredContent.mws. Readers ignore members they do not know. additionalProperties is never false here or in any member, so that a later MINOR version stays valid.",
  type: "object",
  required: ["shape", "outcome"],
  properties: {
    shape: { const: "write-result/0.1" },
    outcome: { enum: ["applied", "not_applied", "partial", "unknown", "accepted"] },
    repeat: { enum: ["no", "yes", "same_key", "same_version", "read_first"] },
    operation: STRING,
    object: {
      type: "object",
      properties: {
        type: STRING,
        id: IDV,
        version: IDV,
        scope: STRING,
        parent: { type: "object", properties: { type: STRING, id: IDV, version: IDV } },
      },
    },
    changed: { type: "array", items: POINTER },
    replayed: { const: true },
    items: {
      type: "array",
      items: {
        type: "object",
        required: ["outcome"],
        anyOf: [{ required: ["index"] }, { required: ["step"] }, { required: ["id"] }],
        properties: {
          index: { type: "integer", minimum: 0 },
          step: STRING,
          id: IDV,
          version: IDV,
          outcome: { enum: ["applied", "not_applied", "not_attempted", "unknown"] },
          code: CODE,
          message: STRING,
          conflict: { $ref: "#/$defs/conflict" },
        },
      },
    },
    applied_count: { type: "integer", minimum: 0 },
    code: {
      $comment: "Reserved in 0.1: conflict, locked, version_required, invalid_argument, not_found, idempotency_key_reused, in_progress, key_not_known, unavailable, not_sent, no_answer, backend_error, internal_error. A server may define others.",
      ...CODE,
    },
    message: STRING,
    argument: POINTER,
    argument_errors: {
      type: "array",
      items: {
        type: "object",
        required: ["argument"],
        properties: { argument: POINTER, code: CODE, message: STRING },
      },
    },
    conflict: { $ref: "#/$defs/conflict" },
    read_with: {
      type: "object",
      required: ["tool", "arguments"],
      properties: { tool: STRING, arguments: { type: "object" } },
    },
    version_argument: STRING,
  },
  $defs: {
    idv: {
      $comment: "An identifier or a version: a string, or an integer between -(2^53-1) and 2^53-1.",
      type: ["string", "integer"],
    },
    conflict: {
      type: "object",
      properties: {
        current_version: IDV,
        checked_by: { enum: ["backend", "server"] },
        current_state: { type: "object" },
        omitted: { type: "array", items: POINTER },
        held_by: STRING,
      },
    },
  },
} as const;

export interface OwnOutput {
  /** The tool's own output members (beside mws). */
  properties?: Record<string, unknown>;
  /** The own members required in a result whose outcome is "applied". */
  required?: string[];
}

/**
 * The outputSchema for a write tool whose structured results carry the shape: `mws` required, the
 * shape inlined (its $defs hoisted to the root so that its internal references resolve), and the
 * tool's own members required only where `mws.outcome` is "applied".
 */
export function outputSchemaFor(own: OwnOutput = {}): Record<string, unknown> {
  const { $schema: _s, $comment: _c, $defs, ...shape } = WRITE_RESULT_SCHEMA;
  return {
    type: "object",
    properties: { ...(own.properties ?? {}), mws: { $ref: "#/$defs/write_result" } },
    required: ["mws"],
    ...(own.required?.length
      ? { if: { properties: { mws: { properties: { outcome: { const: "applied" } } } } }, then: { required: own.required } }
      : {}),
    $defs: { ...$defs, write_result: shape },
  };
}
