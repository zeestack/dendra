// RFC 7591 — dynamic client registration. MCP clients self-register and get a
// client_id (public client, PKCE, no secret).
import { oauth } from "@/server/oauth-store";

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    redirect_uris?: unknown;
  };
  const redirectUris = Array.isArray(body.redirect_uris)
    ? (body.redirect_uris as string[])
    : [];
  const client = oauth.registerClient(redirectUris);
  return Response.json(
    {
      client_id: client.clientId,
      redirect_uris: client.redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
    },
    { status: 201 },
  );
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
