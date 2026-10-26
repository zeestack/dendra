// Authorization endpoint (code flow + PKCE). DEMO: auto-approves as a fixed user.
// A real app would require login + a consent screen here before issuing the code.
import { oauth } from "@/server/oauth-store";
import { tenantFromHost } from "@/server/context";

export function GET(req: Request) {
  const p = new URL(req.url).searchParams;
  const clientId = p.get("client_id") ?? "";
  const redirectUri = p.get("redirect_uri") ?? "";
  const state = p.get("state") ?? "";
  const codeChallenge = p.get("code_challenge") ?? "";
  const method = p.get("code_challenge_method") ?? "";

  const client = oauth.getClient(clientId);
  if (!client) return new Response("unknown client", { status: 400 });
  if (client.redirectUris.length && !client.redirectUris.includes(redirectUri)) {
    return new Response("invalid redirect_uri", { status: 400 });
  }
  if (!codeChallenge || method !== "S256") {
    return new Response("PKCE (S256) required", { status: 400 });
  }

  // DEMO auto-approval — replace with login + consent in production. The token
  // is bound to the workspace being authorized (this host's tenant); a real app
  // checks the user is a member of it here.
  const code = oauth.issueCode({
    clientId,
    redirectUri,
    codeChallenge,
    user: "demo",
    tenantId: tenantFromHost(req.headers.get("host") ?? ""),
  });

  const dest = new URL(redirectUri);
  dest.searchParams.set("code", code);
  if (state) dest.searchParams.set("state", state);
  return Response.redirect(dest.toString(), 302);
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
