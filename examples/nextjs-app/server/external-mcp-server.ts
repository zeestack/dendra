// A self-contained *external* MCP server, used to demo dendra consuming tools
// from someone else's MCP server (the inbound direction). It's a plain
// low-level MCP `Server` (no Zod, plain JSON Schema) exposing two demo tools.
//
// In a real app you wouldn't write this — you'd point a client at an existing
// MCP server (GitHub's, Linear's, a filesystem server, …) over stdio or HTTP.
// Here we keep it in-process so the example is always runnable with no network
// or credentials. The protocol handshake is 100% real; only the transport is
// local (see mcp-tools.ts, which links it with InMemoryTransport).

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

export function createExternalMcpServer(): Server {
  const server = new Server(
    { name: "demo-external-tools", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  // tools/list — plain JSON Schema, exactly what a real MCP server returns.
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "weather.get",
        description: "Get the current (demo) weather for a city",
        inputSchema: {
          type: "object",
          properties: { city: { type: "string", description: "City name" } },
          required: ["city"],
        },
      },
      {
        name: "time.now",
        description: "Get the current server time (ISO 8601)",
        inputSchema: { type: "object", properties: {} },
      },
    ],
  }));

  // tools/call — return JSON text (dendra's createMcpToolSource parses it).
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    if (name === "weather.get") {
      const city = String((args as { city?: string })?.city ?? "somewhere");
      // Deterministic pseudo-weather so the demo is stable.
      const conditions = ["Sunny", "Cloudy", "Rainy", "Windy"];
      const seed = [...city].reduce((a, c) => a + c.charCodeAt(0), 0);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              city,
              condition: conditions[seed % conditions.length],
              tempC: 10 + (seed % 20),
            }),
          },
        ],
      };
    }
    if (name === "time.now") {
      return {
        content: [{ type: "text", text: JSON.stringify({ now: new Date().toISOString() }) }],
      };
    }
    return {
      content: [{ type: "text", text: `Unknown tool: ${name}` }],
      isError: true,
    };
  });

  return server;
}
