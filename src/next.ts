// Optional Next.js helper, imported via the `dendra/next` subpath so core stays
// zero-dependency — `next` is an optional peer dependency you only need if you
// use this file.
//
// A Server Component that loads data through `createCaller` (or the client)
// wants failures as pages, not a crashed render: a missing record is a 404, a
// missing session is a trip to sign-in. `orPage` maps those error codes onto
// Next's own `notFound()` and `redirect()`. `createServerCaller` gives that
// Server Component a caller whose `ctx` comes from the incoming request, built
// by the same `createContext` the route handler uses.

import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import * as React from "react";
import { createCaller, type Caller } from "./caller.ts";

export interface OrPageOptions {
  /** Where UNAUTHORIZED goes. Without it, UNAUTHORIZED is rethrown. */
  signIn?: string;
}

/**
 * Await a procedure call in a Server Component, turning dendra errors into
 * pages: NOT_FOUND and BAD_REQUEST (a bad id in the URL) → `notFound()`,
 * UNAUTHORIZED → `redirect(signIn)`. Anything else is rethrown as-is, for the
 * nearest `error.tsx`.
 *
 * ```ts
 * const note = await orPage(caller.notes.get({ id }), { signIn: "/sign-in" });
 * ```
 */
export async function orPage<T>(call: PromiseLike<T>, opts: OrPageOptions = {}): Promise<T> {
  try {
    return await call;
  } catch (e) {
    // DendraError (caller) or DendraClientError (client). Matched by name, not
    // instanceof: each build entry can carry its own copy of the classes.
    const name = e instanceof Error ? e.name : undefined;
    const code =
      name === "DendraError" || name === "DendraClientError"
        ? (e as { code?: string }).code
        : undefined;
    if (code === "NOT_FOUND" || code === "BAD_REQUEST") notFound();
    if (code === "UNAUTHORIZED" && opts.signIn) redirect(opts.signIn);
    throw e;
  }
}

/**
 * A typed in-process caller for Server Components, with `ctx` built from the
 * incoming request by your route handler's `createContext`. Call it per render:
 * it reads `headers()`, so the page renders dynamically.
 *
 * `createContext` gets a `Request` with the incoming headers (cookies included)
 * and the request's origin as its URL — Server Components don't see the path.
 * Inside Next, `ctx` is built once per request, however many layouts and pages
 * ask for it.
 *
 * ```ts
 * // server/caller.ts
 * export const serverCaller = createServerCaller(appRouter, createContext);
 *
 * // app/notes/[id]/page.tsx
 * const api = await serverCaller();
 * const note = await orPage(api.notes.get({ id }), { signIn: "/sign-in" });
 * ```
 */
export function createServerCaller<R extends object, Ctx>(
  router: R,
  createContext: (req: Request) => Ctx | Promise<Ctx>,
): () => Promise<Caller<R>> {
  // React's `cache` memoizes per request in Server Components. React 18 outside
  // Next has no `cache` (nor its types); there every call builds its own ctx.
  const perRequest = (React as { cache?: <F>(fn: F) => F }).cache ?? (<F,>(fn: F) => fn);
  return perRequest(async () => {
    const h = await headers();
    const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost";
    const proto = h.get("x-forwarded-proto") ?? "http";
    const req = new Request(`${proto}://${host}/`, { headers: new Headers(h) });
    return createCaller(router, await createContext(req));
  });
}
