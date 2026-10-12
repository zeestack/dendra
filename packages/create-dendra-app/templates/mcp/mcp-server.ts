// Stdio MCP server — for Claude Desktop (and other stdio MCP clients).
// Run it with:  npm run mcp:stdio
// Then point Claude Desktop at it (see README). It serves the same .ai()
// procedures from server/router.ts as MCP tools.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createMcpBridge } from "dendra";
import { appRouter } from "./server/router";
import { createContext } from "./server/context";

const bridge = createMcpBridge(appRouter, createContext());
const safe = (n: string) => n.replace(/[^a-zA-Z0-9_-]/g, "_");
const original = new Map(bridge.listTools().map((d) => [safe(d.name), d.name]));

const server = new Server(
  { name: "{{projectName}}", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: bridge.listTools().map((d) => ({
    name: safe(d.name),
    description: d.description,
    inputSchema: d.inputSchema,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = original.get(req.params.name) ?? req.params.name;
  const result = await bridge.callTool(name, req.params.arguments);
  return { content: result.content, isError: result.isError };
});

await server.connect(new StdioServerTransport());
console.error("{{projectName}} MCP server running on stdio");
