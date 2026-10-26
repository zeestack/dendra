// Verifies the MCP server the way Claude would: spawn it, list tools, call them.
// Requires the Next app running with a service token for tenant "acme", so you
// can see the created note isolated to that tenant:
//
//   MCP_TOKENS=acme:claude:dev-acme-token npm run dev
//   MCP_TOKEN=dev-acme-token node mcp-test.ts

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["mcp-server.ts"],
  env: { ...process.env, MCP_TOKEN: process.env.MCP_TOKEN ?? "dev-acme-token" },
});

const client = new Client({ name: "mcp-test", version: "1.0.0" });
await client.connect(transport);

console.log("tools:", (await client.listTools()).tools.map((t) => t.name));

const created = await client.callTool({
  name: "notes_create",
  arguments: { title: "Created by Claude via MCP", body: "hello from MCP" },
});
console.log("notes_create ->", JSON.stringify(created.content));

const listed = await client.callTool({ name: "notes_list", arguments: {} });
console.log("notes_list   ->", JSON.stringify(listed.content));

const summary = await client.callTool({
  name: "ai_summarize",
  arguments: { text: "dendra exposes one router as RPC, REST, OpenAPI, typed clients, and MCP tools." },
});
console.log("ai_summarize ->", JSON.stringify(summary.content));

await client.close();
console.log("\nMCP server verified ✓");
