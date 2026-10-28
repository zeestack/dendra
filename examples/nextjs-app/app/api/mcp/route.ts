// Remote MCP endpoint (Streamable HTTP, stateless JSON-RPC) so claude.ai (web)
// and other remote MCP clients can reach the app over a URL — the local stdio
// server (mcp-server.ts) only works inside the native desktop app.
//
// Exposes the same .ai() procedures as tools, executed IN-PROCESS (this route is
// inside the app) with per-request tenant/user context. Tool results are returned
// as a single JSON response (no SSE needed for unary tools).
//
// Auth: with MCP_OAUTH=1 or MCP_TOKENS set, requires `Authorization: Bearer
// <token>`, and the token alone decides the workspace (see credentials.ts).
// To use from claude.ai: expose this over public HTTPS (a tunnel like cloudflared
// or a deploy), then add <url>/api/mcp as a custom connector in Claude settings.

import { mcpToolDefinitions, createToolExecutor } from "dendra";
import { appRouter } from "@/server/router";
import { createContext, type Ctx } from "@/server/context";
import { bearerToken, legacyConfigError, tokensRequired } from "@/server/credentials";
import { baseUrl } from "@/server/oauth-store";

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
  // Fail closed on the old single-token setting instead of serving MCP open.
  const configError = legacyConfigError();
  if (configError) {
    console.error(`[mcp] ${configError}`);
    return json({ jsonrpc: "2.0", id: null, error: { code: -32603, message: configError } }, 500);
  }

  // When auth is configured, a missing or unknown token is a 401. In OAuth mode
  // the WWW-Authenticate points at the resource metadata so an MCP client (e.g.
  // claude.ai) can discover the auth server and start the flow.
  const unauthorized = () =>
    new Response(
      JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unauthorized" } }),
      {
        status: 401,
        headers: {
          "content-type": "application/json",
          ...(process.env.MCP_OAUTH === "1" && {
            "WWW-Authenticate": `Bearer resource_metadata="${baseUrl(req)}/.well-known/oauth-protected-resource"`,
          }),
        },
      },
    );
  if (tokensRequired() && !bearerToken(req)) return unauthorized();

  // The tenant/user come from the token (createContext), so an MCP connection
  // authorized for workspace A can only ever act in workspace A.
  let ctx: Ctx;
  try {
    ctx = await createContext(req);
  } catch {
    return unauthorized();
  }
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
          serverInfo: { name: "dendra-notes", version: "0.0.1" },
        });
      case "tools/list":
        return reply({ tools: toolDefs });
      case "tools/call": {
        const name = m.params?.name as string;
        const args = (m.params?.arguments as unknown) ?? {};
        const original = safeToOriginal.get(name);
        try {
          if (!original) throw new Error(`Tool '${name}' not found`);
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
  return new Response("dendra-notes MCP endpoint — POST JSON-RPC here.", { status: 405 });
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
