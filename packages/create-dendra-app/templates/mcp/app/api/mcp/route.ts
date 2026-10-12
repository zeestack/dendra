// Remote MCP endpoint (Streamable HTTP, JSON-RPC). Point claude.ai (or any remote
// MCP client) at http://localhost:3000/api/mcp to call your .ai() procedures.
// Open for local dev — add auth (a bearer token or OAuth) before exposing it.
import { createMcpBridge } from "dendra";
import { appRouter } from "@/server/router";
import { createContext } from "@/server/context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// MCP/LLM tool names must match ^[a-zA-Z0-9_-]+$; ours are dotted (notes.list),
// so expose sanitized names and map them back on call.
const safe = (n: string) => n.replace(/[^a-zA-Z0-9_-]/g, "_");

export async function POST(req: Request) {
  const bridge = createMcpBridge(appRouter, createContext());
  const defs = bridge.listTools();
  const original = new Map(defs.map((d) => [safe(d.name), d.name]));

  const { id, method, params } = await req.json();
  const ok = (result: unknown) => Response.json({ jsonrpc: "2.0", id, result });

  switch (method) {
    case "initialize":
      return ok({
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "{{projectName}}", version: "0.1.0" },
      });
    case "notifications/initialized":
      return new Response(null, { status: 202 });
    case "tools/list":
      return ok({ tools: defs.map((d) => ({ ...d, name: safe(d.name) })) });
    case "tools/call": {
      const name = original.get(params?.name) ?? params?.name;
      return ok(await bridge.callTool(name, params?.arguments));
    }
    default:
      return Response.json({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      });
  }
}
