// `createCaller` = "RPC with no HTTP". It walks the router and returns a typed
// facade whose methods invoke procedures in-process. This is what a Next Server
// Component calls for zero-round-trip data loading, and what the AI tool
// executor uses to run a tool. The `Client<R>` type below is the single mapped
// type that makes the whole framework typesafe with no codegen: it reads the
// router's shape and projects each procedure to a typed function.

import type { Proc, ReadBrand } from "./core.ts";
import { invokeStream, invokeUnary } from "./core.ts";
import { isFileResult, toBlob, type FileResult } from "./files.ts";

/** Per-call options, the optional second argument of every procedure call. */
export interface CallOptions {
  /** Abort the call: a pending result rejects, and a stream ends, with the reason. */
  signal?: AbortSignal;
}

// Recursion uses `object` (not the index-signature `RouterRecord`) so a class
// instance used as a sub-router — which has no index signature — still maps. A
// Proc is matched first; any other object recurses; primitives become `never`.
export type Client<R> = {
  // Match the ctx slot with `any` so the conditional fires regardless of the
  // concrete context type (ctx is contravariant in `handler`).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [K in keyof R]: R[K] extends Proc<any, infer In, infer Out, infer Kind>
    ? (Kind extends "stream"
        ? (input: In, opts?: CallOptions) => AsyncIterable<Out>
        : (input: In, opts?: CallOptions) => Promise<Out extends FileResult ? Blob : Out>) &
        (R[K] extends ReadBrand ? ReadBrand : unknown)
    : R[K] extends object
      ? Client<R[K]>
      : never;
};

export function createCaller<R extends object>(
  router: R,
  ctx: unknown = {},
): Client<R> {
  const wrap = (node: unknown, path: string): unknown => {
    if (isProc(node)) {
      const site = { path, transport: "caller" as const };
      if (node.kind === "stream") {
        return async function* (input: unknown, opts?: CallOptions) {
          const signal = opts?.signal;
          yield* invokeStream(node, input, ctx, { ...site, signal });
          // The handler stopped because of the abort: say so, like the client.
          signal?.throwIfAborted();
        };
      }
      // A file comes back as a Blob, matching what the HTTP client returns.
      return async (input: unknown, opts?: CallOptions) => {
        opts?.signal?.throwIfAborted();
        const out = await abortable(invokeUnary(node, input, ctx, site), opts?.signal);
        return isFileResult(out) ? toBlob(out) : out;
      };
    }
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(node as Record<string, unknown>)) {
      out[k] = wrap((node as Record<string, unknown>)[k], path ? `${path}.${k}` : k);
    }
    return out;
  };
  return wrap(router, "") as Client<R>;
}

/**
 * Settle with `p`, or reject with the signal's reason if it aborts first. The
 * work itself isn't stopped (unary handlers take no signal) — the caller just
 * stops waiting for it.
 */
export function abortable<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function isProc(
  n: unknown,
): n is Proc<unknown, unknown, unknown, "unary" | "stream"> {
  return typeof n === "object" && n !== null && (n as { _dendra?: true })._dendra === true;
}
