// MCP bridge. The Model Context Protocol is, at its core, `tools/list` +
// `tools/call` — which is exactly what we already have: `toToolset` produces the
// schemas, and the tool executor runs them with validation. So this file is a
// thin, zero-dependency shaping layer; the example wires it to the official MCP
// SDK transport (stdio / HTTP). Only `.ai()`-exposed procedures are surfaced.

import { createToolExecutor, toToolset } from "./tools.ts";

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpCallResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/** MCP `tools/list` payload derived from the router's `.ai()` procedures. */
export function mcpToolDefinitions(router: object): McpToolDef[] {
  return toToolset(router, { format: "plain" }) as McpToolDef[];
}

/**
 * In-process bridge: list + call tools against the router directly (own data).
 * For calling a *running* app instead, see the example's HTTP-proxy server.
 */
export function createMcpBridge<Ctx>(router: object, ctx: Ctx) {
  const execute = createToolExecutor(router, ctx);
  return {
    listTools(): McpToolDef[] {
      return mcpToolDefinitions(router);
    },
    async callTool(name: string, args: unknown): Promise<McpCallResult> {
      try {
        const result = await execute(name, args ?? {});
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (e) {
        return {
          content: [{ type: "text", text: (e as Error).message }],
          isError: true,
        };
      }
    },
  };
}
