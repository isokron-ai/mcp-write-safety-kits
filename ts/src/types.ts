// Structural types for the parts of MCP the kit touches.
//
// They are written out here, instead of imported from an SDK, so that the kit has no runtime
// dependency and works with any SDK whose types have these shapes: `@modelcontextprotocol/sdk`
// 1.x (`CallToolResult`, `Tool`, `ToolAnnotations` in `types.js`) and the 2.x packages
// (`@modelcontextprotocol/server`). A value of these types can be returned from an SDK tool handler
// as it is.

/** A text block of a tool result. */
export interface TextContent {
  type: "text";
  text: string;
  [key: string]: unknown;
}

/** A tool result, as `tools/call` returns it. */
export interface CallToolResult {
  content: Array<TextContent | { type: string; [key: string]: unknown }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
  [key: string]: unknown;
}

/** The four tool annotations of the MCP schema (revisions 2025-11-25 and 2026-07-28). */
export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
  [key: string]: unknown;
}

/** A tool definition, as `tools/list` returns it. */
export interface Tool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown> & { type: "object" };
  outputSchema?: Record<string, unknown>;
  annotations?: ToolAnnotations;
  _meta?: Record<string, unknown>;
  [key: string]: unknown;
}

/** A value that may be awaited. */
export type MaybePromise<T> = T | Promise<T>;
