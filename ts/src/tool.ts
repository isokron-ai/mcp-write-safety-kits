// defineTool: one place where a tool gets strict inputs, explicit annotations and a truthful
// answer when its handler throws. The result is plain data (a `Tool` for tools/list and a `call`
// function), so it can be served by any MCP SDK.

import { readOnlyHints, writeHints, type ExplicitAnnotations, type ReadToolHints, type WriteToolHints } from "./annotations.js";
import { guardWrite } from "./outcome.js";
import { notApplied, q, type ReadWith } from "./result.js";
import { strictInput, type JsonSchema } from "./strict-input.js";
import type { CallToolResult, MaybePromise, Tool } from "./types.js";

interface ToolBase<A> {
  name: string;
  title?: string;
  description: string;
  /** The input schema, in the supported JSON Schema subset. It is advertised with additionalProperties: false. */
  inputSchema: JsonSchema & { type: "object" };
  outputSchema?: Record<string, unknown>;
  /** Called only with arguments that passed the schema. */
  handler(args: A, extra?: unknown): MaybePromise<CallToolResult>;
}

export interface ReadToolSpec<A> extends ToolBase<A> {
  kind: "read";
  hints?: ReadToolHints;
}

export interface WriteToolSpec<A> extends ToolBase<A> {
  kind: "write";
  hints?: WriteToolHints;
  /**
   * The read that shows whether a write of this call took effect, from the call's (valid)
   * arguments. When the handler throws, the answer says the outcome is unknown and gives this read
   * as `read_with` (MWS-RES-2).
   */
  readWith(args: A): ReadWith;
  /**
   * The argument that takes the version, where the schema requires it. Inferred from the schema
   * when left out (a single required argument named like `expected_version`). A call that leaves it
   * out gets code "version_required" (NF-3), which takes precedence over "invalid_argument".
   */
  versionArgument?: string;
}

export type ToolSpec<A> = ReadToolSpec<A> | WriteToolSpec<A>;

export interface DefinedTool {
  readonly kind: "read" | "write";
  /** The definition for tools/list. */
  readonly definition: Tool & { annotations: ExplicitAnnotations };
  /** Validates the arguments, then runs the handler. Never throws for a handler error. */
  call(args: unknown, extra?: unknown): Promise<CallToolResult>;
}

/** Defines a tool. Throws SchemaError when the input schema uses a keyword the validator does not enforce. */
export function defineTool<A = Record<string, unknown>>(spec: ToolSpec<A>): DefinedTool {
  const input = strictInput(spec.inputSchema, { versionArgument: spec.kind === "write" ? spec.versionArgument : undefined });
  const annotations = spec.kind === "read" ? readOnlyHints(spec.hints) : writeHints(spec.hints);
  const definition = {
    name: spec.name,
    ...(spec.title ? { title: spec.title } : {}),
    description: spec.description,
    inputSchema: input.schema as Tool["inputSchema"],
    ...(spec.outputSchema ? { outputSchema: spec.outputSchema } : {}),
    annotations,
  };
  return {
    kind: spec.kind,
    definition,
    async call(args, extra) {
      const v = input.validate(args);
      if (!v.ok) return v.result;
      const run = async () => spec.handler(v.value as A, extra);
      if (spec.kind === "write") {
        return guardWrite(run, { readWith: spec.readWith(v.value as A), what: `the call to ${q(spec.name)}` });
      }
      try {
        return await run();
      } catch {
        return notApplied({ summary: `${q(spec.name)} could not read: a fault in the server`, code: "read_failed" });
      }
    },
  };
}

/** Thrown by ToolSet.call for a name the set does not hold (a protocol error in MCP terms). */
export class UnknownToolError extends Error {
  override readonly name = "UnknownToolError";
  constructor(readonly tool: string) {
    super(`Unknown tool: ${tool}`);
  }
}

/** A set of defined tools, for a server's tools/list and tools/call handlers. */
export class ToolSet {
  private readonly byName = new Map<string, DefinedTool>();

  constructor(tools: DefinedTool[]) {
    for (const t of tools) {
      if (this.byName.has(t.definition.name)) throw new Error(`duplicate tool name ${q(t.definition.name)}`);
      this.byName.set(t.definition.name, t);
    }
  }

  /** The result of tools/list, in a stable order (the order the tools were given). */
  list(): { tools: Tool[] } {
    return { tools: [...this.byName.values()].map((t) => t.definition) };
  }

  /** The names of the write tools (the server's own record of which tools write, for a read-only mode: MWS-CFG-3). */
  writeTools(): string[] {
    return [...this.byName.values()].filter((t) => t.kind === "write").map((t) => t.definition.name);
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  /** Runs tools/call. Throws UnknownToolError for a name the set does not hold. */
  async call(name: string, args: unknown, extra?: unknown): Promise<CallToolResult> {
    const t = this.byName.get(name);
    if (!t) throw new UnknownToolError(name);
    return t.call(args, extra);
  }
}
