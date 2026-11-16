#!/usr/bin/env node
// notes-server: the MCP layer. The official TypeScript SDK's low-level Server (1.x), stateless
// Streamable HTTP on 127.0.0.1, with tools/list and tools/call answered by the kit's ToolSet.
//
//   node dist/src/main.js [--port N]
//
// The first line on stdout is JSON with the endpoint: {"mcp":"http://127.0.0.1:<port>/mcp"}.
// The store is in memory: a restart starts empty.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";
import { UnknownToolError, annotationProblems, type ToolSet } from "@mcp-write-safety/kit";
import { NotesStore } from "./store.js";
import { buildTools } from "./tools.js";

export const SERVER_INFO = { name: "notes-server", version: "0.1.0" };

/** One MCP Server object over the shared tool set (stateless: one per HTTP request). */
export function mcpServer(tools: ToolSet): Server {
  const server = new Server(SERVER_INFO, {
    capabilities: { tools: {} },
    instructions: "A small notes store. Read a note's version with get_note and pass it as expected_version when you update or delete it.",
  });
  server.setRequestHandler(ListToolsRequestSchema, async () => tools.list() as never);
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      return (await tools.call(req.params.name, req.params.arguments)) as never;
    } catch (e) {
      if (e instanceof UnknownToolError) throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${e.tool}`);
      throw e;
    }
  });
  return server;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const MAX_BODY = 1024 * 1024;

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw Object.assign(new Error("body too large"), { status: 413 });
    chunks.push(c as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export interface Running {
  url: string;
  store: NotesStore;
  close(): Promise<void>;
}

export async function start(port = 0): Promise<Running> {
  const store = new NotesStore();
  const tools = buildTools(store);
  const problems = annotationProblems(tools.list().tools, tools.writeTools());
  if (problems.length) throw new Error(`annotations: ${problems.join("; ")}`);

  const http = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        // DNS-rebinding guard: loopback Host only.
        if (!LOOPBACK.has((req.headers.host ?? "").replace(/:\d+$/, ""))) return void res.writeHead(403).end("loopback only");
        if (!/^\/mcp(\?|$)/.test(req.url ?? "")) return void res.writeHead(404).end("the MCP endpoint is /mcp");
        if (req.method !== "POST") {
          return void res.writeHead(405, { allow: "POST", "content-type": "application/json" })
            .end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server: POST only)" }, id: null }));
        }
        const body = await readJson(req);
        const server = mcpServer(tools);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        res.on("close", () => {
          void transport.close();
          void server.close();
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
      } catch (e) {
        if (!res.headersSent) {
          const status = (e as { status?: number }).status ?? (e instanceof SyntaxError ? 400 : 500);
          res.writeHead(status, { "content-type": "application/json" })
            .end(JSON.stringify({ jsonrpc: "2.0", error: { code: status === 400 ? -32700 : -32603, message: status === 400 ? "Parse error" : "Internal error" }, id: null }));
        } else res.end();
      }
    })();
  });
  await new Promise<void>((resolve) => http.listen(port, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`;
  return {
    url,
    store,
    close: () => new Promise<void>((resolve) => {
      http.closeAllConnections();
      http.close(() => resolve());
    }),
  };
}

const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("/notes-server");
if (isMain) {
  const i = process.argv.indexOf("--port");
  const port = i >= 0 ? Number(process.argv[i + 1]) : Number(process.env["NOTES_PORT"] ?? 0);
  const running = await start(Number.isInteger(port) && port >= 0 ? port : 0);
  process.stdout.write(`${JSON.stringify({ mcp: running.url })}\n`);
  const stop = () => void running.close().then(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
