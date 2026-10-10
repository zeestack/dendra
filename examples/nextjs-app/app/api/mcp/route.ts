// Remote MCP endpoint (Streamable HTTP, stateless JSON-RPC) so claude.ai (web)
// and other remote MCP clients can reach the app over a URL — the local stdio
// server (mcp-server.ts) only works inside the native desktop app.
//
// Exposes the same .ai() procedures as tools, executed IN-PROCESS (this route is
// inside the app) with per-request tenant/user context. Tool results are returned
// as a single JSON response (no SSE needed for unary tools).
//
// Auth: if MCP_TOKEN is set, requires `Authorization: Bearer <token>`.
// To use from claude.ai: expose this over public HTTPS (a tunnel like cloudflared
// or a deploy), then add <url>/api/mcp as a custom connector in Claude settings.

import { mcpToolDefinitions, createToolExecutor } from "nexus-rpc";
import { appRouter } from "@/server/router";
import { createContext } from "@/server/context";
import { oauth, baseUrl } from "@/server/oauth-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Tool names must match ^[a-zA-Z0-9_-]+$ — expose underscored, map back on call.
const safeToOriginal = new Map<string, string>();
const toolDefs = mcpToolDefinitions(appRouter).map((t) => {
  const safe = t.name.replace(/[^a-zA-Z0-9_-]/g, "_");
  safeToOriginal.set(safe, t.name);
  return { ...t, name: safe };
});

type JsonRpc = { jsonrpc: "2.0"; id?: string | number; method?: string; params?: Record<string, unknown> };

export async function POST(req: Request): Promise<Response> {
  const authHeader = req.headers.get("authorization") ?? "";
  const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

  // OAuth mode (MCP_OAUTH=1): require a valid token from our authorization server.
  // On failure, 401 with WWW-Authenticate pointing at the resource metadata so an
  // MCP client (e.g. claude.ai) can discover the auth server and start the flow.
  if (process.env.MCP_OAUTH === "1") {
    if (!oauth.validateToken(bearer)) {
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unauthorized" } }),
        {
          status: 401,
          headers: {
            "content-type": "application/json",
            "WWW-Authenticate": `Bearer resource_metadata="${baseUrl(req)}/.well-known/oauth-protected-resource"`,
          },
        },
      );
    }
  } else if (process.env.MCP_TOKEN) {
    // Simple static-token mode (unchanged default behavior).
    if (bearer !== process.env.MCP_TOKEN) {
      return json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unauthorized" } }, 401);
    }
  }

  // Remote clients (claude.ai) don't send x-tenant/x-user headers, so pin the
  // tenant/user for this endpoint via env (defaults keep notes in one place).
  const ctx = await createContext(req);
  ctx.tenantId = process.env.MCP_DEFAULT_TENANT ?? ctx.tenantId;
  ctx.userId = process.env.MCP_DEFAULT_USER ?? ctx.userId;
  const execute = createToolExecutor(appRouter, ctx);

  let body: JsonRpc | JsonRpc[];
  try {
    body = await req.json();
  } catch {
    return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
  }

  const handle = async (m: JsonRpc): Promise<object | null> => {
    const id = m.id ?? null;
    const reply = (result: unknown) => ({ jsonrpc: "2.0", id, result });
    switch (m.method) {
      case "initialize":
        return reply({
          protocolVersion: (m.params?.protocolVersion as string) ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "nexus-notes", version: "0.0.1" },
        });
      case "tools/list":
        return reply({ tools: toolDefs });
      case "tools/call": {
        const name = m.params?.name as string;
        const args = (m.params?.arguments as unknown) ?? {};
        const original = safeToOriginal.get(name) ?? name;
        try {
          const result = await execute(original, args);
          return reply({ content: [{ type: "text", text: JSON.stringify(result) }] });
        } catch (e) {
          return reply({
            content: [{ type: "text", text: (e as Error).message }],
            isError: true,
          });
        }
      }
      case "ping":
        return reply({});
      default:
        // Notifications (e.g. notifications/initialized) get no response.
        if (m.method?.startsWith("notifications/")) return null;
        return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${m.method}` } };
    }
  };

  const result = Array.isArray(body)
    ? (await Promise.all(body.map(handle))).filter(Boolean)
    : await handle(body);

  if (result === null || (Array.isArray(result) && result.length === 0)) {
    return new Response(null, { status: 202 });
  }
  return json(result, 200);
}

export function GET(): Response {
  return new Response("nexus-notes MCP endpoint — POST JSON-RPC here.", { status: 405 });
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
