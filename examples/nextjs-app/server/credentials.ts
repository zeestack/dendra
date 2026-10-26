// Who is calling, and for which workspace. A bearer token is issued for ONE
// tenant, so the tenant comes from the token — never from a header the caller
// controls. createContext uses this for every adapter (RPC, REST, remote MCP),
// so a token for workspace A can't read or write workspace B on any surface.
//
// Two token sources (both demo-grade; swap for your IdP / token store):
//   - OAuth access tokens from the demo authorization server (oauth-store.ts)
//   - static service tokens from MCP_TOKENS="<tenant>:<user>:<token>,…"
//     (e.g. for the stdio MCP server or scripts)

import { oauth } from "./oauth-store.ts";

export interface Principal {
  tenantId: string;
  userId: string;
}

function staticTokens(): Map<string, Principal> {
  const map = new Map<string, Principal>();
  for (const entry of (process.env.MCP_TOKENS ?? "").split(",")) {
    const [tenantId, userId, token] = entry.trim().split(":");
    if (tenantId && userId && token) map.set(token, { tenantId, userId });
  }
  return map;
}

/** True when the app is configured to require a token on the MCP endpoint. */
export function tokensRequired(): boolean {
  return process.env.MCP_OAUTH === "1" || staticTokens().size > 0;
}

export function bearerToken(req: Request): string | null {
  const header = req.headers.get("authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() || null : null;
}

/** The tenant + user a token was issued for, or null if it's unknown/expired. */
export function principalFromToken(token: string): Principal | null {
  const fixed = staticTokens().get(token);
  if (fixed) return fixed;
  const issued = oauth.validateToken(token);
  return issued ? { tenantId: issued.tenantId, userId: issued.user } : null;
}
