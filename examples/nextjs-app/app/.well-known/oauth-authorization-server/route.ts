// RFC 8414 — authorization server metadata: where to register, authorize, and
// exchange tokens. PKCE (S256) required; public clients (no secret).
import { baseUrl } from "@/server/oauth-store";

export function GET(req: Request) {
  const base = baseUrl(req);
  return Response.json({
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
  });
}

export const dynamic = "force-dynamic";
