// The JSON Schema of the write-result shape, version 0.1, and a helper that builds a write tool's
// outputSchema as B-9 advises: `mws` required, the tool's own output members required only when
// `outcome` is "applied" (valid whether or not error results must conform; MCP issue 569), and the
// shape's schema inlined under $defs rather than referenced remotely.
//
// The same schema ships as schema/write-result-0.1.schema.json (a test checks that they agree).

const STRING = { type: "string" } as const;
const POINTER = { type: "string", pattern: "^(/.*)?$" } as const;
const CODE = { type: "string", pattern: "^[a-z0-9_]+$" } as const;

/** The JSON Schema (2020-12) of `structuredContent.mws`, write-result/0.1. */
export const WRITE_RESULT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "MWS write-result 0.1 (draft, Annex B-9)",
  description: "The value of structuredContent.mws. Readers ignore members they do not know.",
  type: "object",
  required: ["shape", "outcome"],
  properties: {
    shape: { type: "string", pattern: "^write-result/0\\.[0-9]+$" },
    outcome: { enum: ["applied", "not_applied", "partial", "unknown", "accepted"] },
    repeat: { enum: ["no", "yes", "same_key", "same_version", "read_first"] },
    operation: STRING,
    object: {
      type: "object",
      properties: { type: STRING, id: STRING, version: STRING, scope: STRING },
    },
    changed: { type: "array", items: POINTER },
    replayed: { const: true },
    items: {
      type: "array",
      items: {
        type: "object",
        required: ["index", "outcome"],
        properties: {
          index: { type: "integer", minimum: 0 },
          step: STRING,
          id: STRING,
          version: STRING,
          outcome: { enum: ["applied", "not_applied", "not_attempted", "unknown"] },
          code: CODE,
          message: STRING,
        },
      },
    },
    applied_count: { type: "integer", minimum: 0 },
    code: CODE,
    message: STRING,
    argument: POINTER,
    conflict: {
      type: "object",
      properties: {
        current_version: STRING,
        version_source: { enum: ["backend", "server"] },
        current_state: { type: "object" },
        omitted: { type: "array", items: POINTER },
        held_by: STRING,
      },
    },
    read_with: {
      type: "object",
      required: ["tool", "arguments"],
      properties: { tool: STRING, arguments: { type: "object" } },
    },
    version_argument: STRING,
  },
} as const;

export interface OwnOutput {
  /** The tool's own output members (beside mws). */
  properties?: Record<string, unknown>;
  /** The own members required in a result whose outcome is "applied". */
  required?: string[];
}

/**
 * The outputSchema for a write tool whose structured results carry the shape: `mws` required and
 * inlined under $defs; the tool's own members required only where `mws.outcome` is "applied".
 */
export function outputSchemaFor(own: OwnOutput = {}): Record<string, unknown> {
  const { $schema: _s, ...shape } = WRITE_RESULT_SCHEMA;
  return {
    type: "object",
    properties: { ...(own.properties ?? {}), mws: { $ref: "#/$defs/write_result" } },
    required: ["mws"],
    ...(own.required?.length
      ? { if: { properties: { mws: { properties: { outcome: { const: "applied" } } } } }, then: { required: own.required } }
      : {}),
    $defs: { write_result: shape },
  };
}
