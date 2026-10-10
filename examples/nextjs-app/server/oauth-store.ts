// Minimal in-memory OAuth 2.1 state (clients, auth codes, access tokens) for the
// demo authorization server that fronts the remote MCP endpoint. PKCE-only public
// clients, short-lived codes, bearer access tokens. Swap for a real identity
// provider / token store in production — this is a demonstration, not hardened.

import { createHash, randomBytes } from "node:crypto";

interface Client {
  clientId: string;
  redirectUris: string[];
}
interface Code {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  user: string;
  expiresAt: number;
}
interface Token {
  clientId: string;
  user: string;
  expiresAt: number;
}

const g = globalThis as unknown as {
  __oauthClients?: Map<string, Client>;
  __oauthCodes?: Map<string, Code>;
  __oauthTokens?: Map<string, Token>;
};
const clients = (g.__oauthClients ??= new Map());
const codes = (g.__oauthCodes ??= new Map());
const tokens = (g.__oauthTokens ??= new Map());

const rand = (n = 32) => randomBytes(n).toString("base64url");

export const oauth = {
  registerClient(redirectUris: string[]): Client {
    const client: Client = { clientId: "client_" + rand(8), redirectUris };
    clients.set(client.clientId, client);
    return client;
  },
  getClient(id: string): Client | null {
    return clients.get(id) ?? null;
  },
  issueCode(data: Omit<Code, "expiresAt">): string {
    const code = rand();
    codes.set(code, { ...data, expiresAt: Date.now() + 60_000 });
    return code;
  },
  consumeCode(code: string): Code | null {
    const rec = codes.get(code);
    if (!rec) return null;
    codes.delete(code); // one-time use
    return rec.expiresAt < Date.now() ? null : rec;
  },
  verifyPkce(verifier: string, challenge: string): boolean {
    const hash = createHash("sha256").update(verifier).digest("base64url");
    return hash === challenge;
  },
  issueToken(clientId: string, user: string): { token: string; expiresIn: number } {
    const token = rand(48);
    const expiresIn = 3600;
    tokens.set(token, { clientId, user, expiresAt: Date.now() + expiresIn * 1000 });
    return { token, expiresIn };
  },
  validateToken(token: string): Token | null {
    const rec = tokens.get(token);
    if (!rec) return null;
    if (rec.expiresAt < Date.now()) {
      tokens.delete(token);
      return null;
    }
    return rec;
  },
};

export function baseUrl(req: Request): string {
  const u = new URL(req.url);
  return `${u.protocol}//${u.host}`;
}
