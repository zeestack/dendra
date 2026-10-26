// OAuth 2.1 *client* for connecting to protected MCP servers (the app acting as
// an MCP client). This is an APP concern — dendra stays auth-agnostic — so it
// lives here, not in the framework.
//
// Flow (handled by the SDK's `auth()` via this provider):
//   1. connect() attempts the MCP handshake with an authProvider attached.
//   2. If the server requires auth, the SDK discovers its OAuth metadata,
//      dynamically registers this app as a client, builds a PKCE authorization
//      URL, and calls redirectToAuthorization() — we capture that URL.
//   3. The browser opens it; the user approves; the server redirects back to our
//      /mcp/callback route with ?code & ?state.
//   4. finishMcpAuth() exchanges the code for tokens and completes the handshake.
//
// The PKCE verifier + dynamic-registration info must survive between (2) and (4),
// across two separate requests — so they're kept in an in-process pending store
// keyed by the OAuth `state` (which is this connection's id).

import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationFull,
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

export interface PendingAuth {
  id: string; // also the OAuth `state`
  url: string; // MCP server URL
  name?: string;
  prefix: string;
  redirectUri: string; // our /mcp/callback
  clientInformation?: OAuthClientInformationFull;
  tokens?: OAuthTokens;
  codeVerifier?: string;
  authorizeUrl?: string; // captured in step 2
  createdAt: number;
}

const g = globalThis as unknown as { __dendraMcpAuth?: Map<string, PendingAuth> };
export function authStore(): Map<string, PendingAuth> {
  if (!g.__dendraMcpAuth) g.__dendraMcpAuth = new Map();
  // Drop stale pending auths (older than 10 min).
  const now = Date.now();
  for (const [k, v] of g.__dendraMcpAuth) {
    if (now - v.createdAt > 10 * 60_000) g.__dendraMcpAuth.delete(k);
  }
  return g.__dendraMcpAuth;
}

/**
 * An OAuthClientProvider backed by one PendingAuth record. All persistence is
 * reads/writes against that record, so the same provider state can be recreated
 * in the callback request by looking the record up by `state`.
 */
export class AppOAuthProvider implements OAuthClientProvider {
  // A plain field, not a `private` parameter property: Node's type stripping
  // (node mcp-server.ts) can't run parameter properties.
  private pending: PendingAuth;
  constructor(pending: PendingAuth) {
    this.pending = pending;
  }

  get redirectUrl(): string {
    return this.pending.redirectUri;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "dendra-notes-app",
      redirect_uris: [this.pending.redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      // Public client (browser-initiated) → PKCE, no client secret.
      token_endpoint_auth_method: "none",
    };
  }

  // Used as the OAuth `state`; the callback finds the pending record with it.
  state(): string {
    return this.pending.id;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.pending.clientInformation;
  }
  saveClientInformation(info: OAuthClientInformationMixed): void {
    this.pending.clientInformation = info as OAuthClientInformationFull;
  }

  tokens(): OAuthTokens | undefined {
    return this.pending.tokens;
  }
  saveTokens(tokens: OAuthTokens): void {
    this.pending.tokens = tokens;
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    // Don't redirect server-side — capture the URL so connect() can hand it to
    // the browser, which opens it for the user.
    this.pending.authorizeUrl = authorizationUrl.toString();
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.pending.codeVerifier = codeVerifier;
  }
  codeVerifier(): string {
    if (!this.pending.codeVerifier) throw new Error("Missing PKCE code verifier");
    return this.pending.codeVerifier;
  }
}
