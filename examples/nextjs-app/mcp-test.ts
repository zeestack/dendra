// Verifies the MCP server the way Claude would: spawn it, list tools, call them.
// Requires the Next app running (npm run dev). Uses tenant "acme" so you can see
// the created note isolated to that tenant.
//
//   node mcp-test.ts

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["mcp-server.ts"],
  env: { ...process.env, TENANT: "acme", MCP_USER: "claude" },
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
  arguments: { text: "nexus-rpc exposes one router as RPC, REST, OpenAPI, typed clients, and MCP tools." },
});
console.log("ai_summarize ->", JSON.stringify(summary.content));

await client.close();
console.log("\nMCP server verified ✓");
