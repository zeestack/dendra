// Optional Next.js helper, imported via the `dendra/next` subpath so core stays
// zero-dependency — `next` is an optional peer dependency you only need if you
// use this file.
//
// A Server Component that loads data through `createCaller` (or the client)
// wants failures as pages, not a crashed render: a missing record is a 404, a
// missing session is a trip to sign-in. `orPage` maps those error codes onto
// Next's own `notFound()` and `redirect()`.

import { notFound, redirect } from "next/navigation";

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
