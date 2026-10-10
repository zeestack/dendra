// MCP server — lets Claude (Desktop/Code) interact with the running Next app.
//
// Tool SCHEMAS come from the router (mcpToolDefinitions); tool EXECUTION proxies
// to the live app over the typed client, so Claude's actions hit the real running
// app and share its data (tenant-scoped). Run the Next app first (npm run dev),
// then point Claude at this via its config (see README).
//
//   npm i @modelcontextprotocol/sdk
//   node mcp-server.ts
//
// Env: APP_URL (default http://localhost:3100), TENANT (default "public"),
//      MCP_USER (default "claude").

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createClient, mcpToolDefinitions } from "dendra";
import { appRouter, type AppRouter } from "./server/router.ts";

const APP_URL = process.env.APP_URL ?? "http://localhost:3100";
const TENANT = process.env.TENANT ?? "public";
const USER = process.env.MCP_USER ?? "claude";

// Typed client to the running app; tenant/user passed as headers.
const api = createClient<AppRouter>(APP_URL, {
  prefix: "/rpc/",
  headers: { "x-tenant": TENANT, "x-user": USER },
});

const server = new Server(
  { name: "dendra-notes", version: "0.0.1" },
  { capabilities: { tools: {} } },
);

// Tool names must match ^[a-zA-Z0-9_-]+$ for the model to accept them, but our
// procedure paths are dotted (notes.list). Expose underscored names and map back
// on call — otherwise Claude silently drops the tools ("not picking up").
const safeToOriginal = new Map<string, string>();
const toolDefs = mcpToolDefinitions(appRouter).map((t) => {
  const safe = t.name.replace(/[^a-zA-Z0-9_-]/g, "_");
  safeToOriginal.set(safe, t.name);
  return { ...t, name: safe };
});

// tools/list — schemas derived from the router's .ai() procedures.
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: toolDefs,
}));

// tools/call — map the safe name back to the dotted path, dispatch to the client.
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  const original = safeToOriginal.get(name) ?? name;
  try {
    // Walk the proxy by path: "notes.create" -> api.notes.create
    const fn = original
      .split(".")
      .reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], api) as (
      input: unknown,
    ) => Promise<unknown>;
    const result = await fn(args ?? {});
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  } catch (e) {
    return {
      content: [{ type: "text", text: (e as Error).message }],
      isError: true,
    };
  }
});

await server.connect(new StdioServerTransport());
// stdout is reserved for the protocol — log to stderr only.
console.error(`nexus MCP server ready (stdio) → ${APP_URL} [tenant=${TENANT}]`);
