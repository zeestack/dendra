// Context is plain and framework-neutral — note there are NO `next/*` types here,
// so these procedures run under any adapter (Next, standalone Node WS, tests).
//
// MULTI-TENANCY lives here and nowhere else: we resolve the tenant from the
// request's host (subdomain) once, put `tenantId` on ctx, and every procedure is
// automatically scoped. Handlers never parse hosts or think about tenancy — they
// just read ctx.tenantId. Swap adapters (WS, tests) and tenancy still works
// because each adapter builds ctx the same way.

import type { PubSub } from "dendra";
import { db } from "./db.ts";
import { pubsub } from "./pubsub.ts";

export interface Ctx {
  tenantId: string;
  userId: string;
  db: typeof db;
  pubsub: PubSub;
  signal?: AbortSignal;
}

/** Per-request context for the HTTP adapters (RPC + REST). */
export async function createContext(req: Request): Promise<Ctx> {
  const host = req.headers.get("host") ?? "";
  const cookie = req.headers.get("cookie") ?? "";
  return {
    // Browsers hit a subdomain; programmatic clients (e.g. the MCP server) can
    // instead pass explicit x-tenant / x-user headers.
    tenantId: req.headers.get("x-tenant") ?? tenantFromHost(host),
    userId: req.headers.get("x-user") ?? parseSession(cookie) ?? "anonymous",
    db,
    pubsub,
    signal: req.signal,
  };
}

/** In-process context for Server Components / the AI executor (no Request). */
export function directContext(userId: string, tenantId = "public"): Ctx {
  return { tenantId, userId, db, pubsub };
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
