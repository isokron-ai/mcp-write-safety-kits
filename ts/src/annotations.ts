// Annotations (MWS-ANN-1 to ANN-4).
//
// The MCP schema's defaults for the four hints are the cautious values (readOnlyHint false,
// destructiveHint true, idempotentHint false, openWorldHint true). MWS-ANN-4 asks a server to
// declare readOnlyHint on every tool and destructiveHint on every tool that is not read-only; the
// helpers here declare all four, every time, and start from the cautious values. An optimistic
// value (read-only, not destructive, idempotent, closed world) is a claim that MWS-ANN-1 to ANN-3
// test against what the tool does, so it is set only where the builder says so.

import type { Tool, ToolAnnotations } from "./types.js";

/** The four hints, all present. */
export interface ExplicitAnnotations extends ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface ReadToolHints {
  /** Default true: the tool may reach entities outside the server's own backend. Set false only for a closed domain. */
  openWorld?: boolean;
  title?: string;
}

export interface WriteToolHints {
  /** Default true. Set false only for a tool that never deletes and never removes or replaces data the caller did not name (MWS-ANN-2), and only adds (MWS-ANN-5). */
  destructive?: boolean;
  /** Default false. Set true only for a tool that has no further effect when called again with the same arguments (MWS-ANN-3). */
  idempotent?: boolean;
  /** Default true. */
  openWorld?: boolean;
  title?: string;
}

/** The hints of a tool that changes nothing (MWS-ANN-1: it must not change state). */
export function readOnlyHints(o: ReadToolHints = {}): ExplicitAnnotations {
  return {
    ...(o.title ? { title: o.title } : {}),
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: o.openWorld ?? true,
  };
}

/** The hints of a write tool, from the cautious defaults. */
export function writeHints(o: WriteToolHints = {}): ExplicitAnnotations {
  return {
    ...(o.title ? { title: o.title } : {}),
    readOnlyHint: false,
    destructiveHint: o.destructive ?? true,
    idempotentHint: o.idempotent ?? false,
    openWorldHint: o.openWorld ?? true,
  };
}

/**
 * Lists what is missing or inconsistent in a catalog's annotations: a tool without one of the
 * four hints (MWS-ANN-4 needs readOnlyHint everywhere and destructiveHint on every tool that is not
 * read-only; the kit asks for all four), and a tool in `writeTools` that declares readOnlyHint
 * true (MWS-ANN-1). An empty list means nothing was found.
 */
export function annotationProblems(tools: Tool[], writeTools: Iterable<string> = []): string[] {
  const writes = new Set(writeTools);
  const out: string[] = [];
  for (const t of tools) {
    const a = t.annotations ?? {};
    for (const h of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const) {
      if (typeof a[h] !== "boolean") out.push(`${t.name}: ${h} is not declared`);
    }
    if (writes.has(t.name) && a.readOnlyHint === true) out.push(`${t.name}: a write tool declares readOnlyHint true`);
  }
  return out;
}
