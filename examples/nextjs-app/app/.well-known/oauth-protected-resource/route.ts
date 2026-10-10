// RFC 9728 — tells an MCP client which authorization server protects /api/mcp.
import { baseUrl } from "@/server/oauth-store";

export function GET(req: Request) {
  const base = baseUrl(req);
  return Response.json({
    resource: `${base}/api/mcp`,
    authorization_servers: [base],
  });
}

export const dynamic = "force-dynamic";
