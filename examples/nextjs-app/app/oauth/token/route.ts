// Token endpoint — exchanges an authorization code (+ PKCE verifier) for a
// bearer access token. Public client, so no client authentication.
import { oauth } from "@/server/oauth-store";

export async function POST(req: Request) {
  const params = new URLSearchParams(await req.text());
  if (params.get("grant_type") !== "authorization_code") {
    return err("unsupported_grant_type");
  }
  const code = params.get("code") ?? "";
  const verifier = params.get("code_verifier") ?? "";
  const redirectUri = params.get("redirect_uri") ?? "";

  const rec = oauth.consumeCode(code);
  if (!rec) return err("invalid_grant", "bad or expired code");
  if (rec.redirectUri !== redirectUri) {
    return err("invalid_grant", "redirect_uri mismatch");
  }
  if (!oauth.verifyPkce(verifier, rec.codeChallenge)) {
    return err("invalid_grant", "PKCE verification failed");
  }

  const { token, expiresIn } = oauth.issueToken(rec.clientId, rec.user);
  return Response.json({
    access_token: token,
    token_type: "Bearer",
    expires_in: expiresIn,
  });
}

function err(error: string, description?: string) {
  return Response.json(
    { error, ...(description ? { error_description: description } : {}) },
    { status: 400 },
  );
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
