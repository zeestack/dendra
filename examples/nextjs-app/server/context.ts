// Context is plain and framework-neutral — note there are NO `next/*` types here,
// so these procedures run under any adapter (Next, standalone Node WS, tests).
//
// MULTI-TENANCY lives here and nowhere else: we resolve the tenant once — from
// the bearer token when there is one (it was issued for one workspace), else
// from the request's host (subdomain) — put `tenantId` on ctx, and every
// procedure is automatically scoped. Handlers never parse hosts or think about
// tenancy — they just read ctx.tenantId. Swap adapters (WS, tests) and tenancy still works
// because each adapter builds ctx the same way.

import { DendraError, type PubSub, type MemoryStore } from "dendra";
import { db } from "./db.ts";
import { pubsub } from "./pubsub.ts";
import { createSqliteMemory } from "./memory.ts";
import { bearerToken, principalFromToken } from "./credentials.ts";

export interface Ctx {
  tenantId: string;
  userId: string;
  /** Origin of the request (e.g. http://localhost:3100) — used for OAuth redirect URIs. */
  origin: string;
  db: typeof db;
  pubsub: PubSub;
  /** Durable, per-user memory (SQLite). Scoping is applied here, once. */
  memory: MemoryStore;
  /** Optional per-request Anthropic key (BYOK), sent by the browser. Falls back
   * to the server's ANTHROPIC_API_KEY when absent. Never stored server-side. */
  anthropicKey?: string;
  signal?: AbortSignal;
}

/** Per-request context for the HTTP adapters (RPC + REST). */
export async function createContext(req: Request): Promise<Ctx> {
  const host = req.headers.get("host") ?? "";
  const cookie = req.headers.get("cookie") ?? "";
  // Programmatic clients (the MCP servers, scripts) send a bearer token, and the
  // token alone decides the tenant + user — a caller can't pick a workspace by
  // header or host. Browsers have no token and use their subdomain.
  const token = bearerToken(req);
  const principal = token ? principalFromToken(token) : null;
  if (token && !principal) throw new DendraError("UNAUTHORIZED", "Invalid or expired token");
  const tenantId = principal?.tenantId ?? tenantFromHost(host);
  const userId = principal?.userId ?? parseSession(cookie) ?? "anonymous";
  return {
    tenantId,
    userId,
    origin: originOf(req, host),
    db,
    pubsub,
    memory: createSqliteMemory(tenantId, userId),
    anthropicKey: req.headers.get("x-anthropic-key")?.trim() || undefined,
    signal: req.signal,
  };
}

/** In-process context for Server Components / the AI executor (no Request). */
export function directContext(userId: string, tenantId = "public"): Ctx {
  return {
    tenantId,
    userId,
    origin: "",
    db,
    pubsub,
    memory: createSqliteMemory(tenantId, userId),
  };
}

function originOf(req: Request, host: string): string {
  try {
    return new URL(req.url).origin;
  } catch {
    const proto = req.headers.get("x-forwarded-proto") ?? "http";
    return host ? `${proto}://${host}` : "";
  }
}

/**
 * Resolve a tenant from a host header.
 *   acme.example.com      → "acme"
 *   acme.localhost:3100   → "acme"
 *   localhost:3100        → "public"   (no subdomain)
 *   www.example.com       → "public"
 * In production, configure your base domain and reject unknown tenants.
 */
export function tenantFromHost(host: string): string {
  const hostname = host.split(":")[0]; // strip port
  const labels = hostname.split(".");
  // Need at least <sub>.<domain> ; localhost counts as one label.
  const bare = hostname === "localhost" || labels.length < 2;
  if (bare) return "public";
  const sub = labels[0];
  if (sub === "www") return "public";
  return sub;
}

function parseSession(cookie: string): string | null {
  const m = /(?:^|;\s*)uid=([^;]+)/.exec(cookie);
  return m ? decodeURIComponent(m[1]) : null;
}
