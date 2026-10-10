// `createCaller` = "RPC with no HTTP". It walks the router and returns a typed
// facade whose methods invoke procedures in-process. This is what a Next Server
// Component calls for zero-round-trip data loading, and what the AI tool
// executor uses to run a tool. The `Client<R>` type below is the single mapped
// type that makes the whole framework typesafe with no codegen: it reads the
// router's shape and projects each procedure to a typed function.

import type { Proc } from "./core.ts";
import { invokeStream, invokeUnary } from "./core.ts";

// Recursion uses `object` (not the index-signature `RouterRecord`) so a class
// instance used as a sub-router — which has no index signature — still maps. A
// Proc is matched first; any other object recurses; primitives become `never`.
export type Client<R> = {
  // Match the ctx slot with `any` so the conditional fires regardless of the
  // concrete context type (ctx is contravariant in `handler`).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [K in keyof R]: R[K] extends Proc<any, infer In, infer Out, infer Kind>
    ? Kind extends "stream"
      ? (input: In) => AsyncIterable<Out>
      : (input: In) => Promise<Out>
    : R[K] extends object
      ? Client<R[K]>
      : never;
};

export function createCaller<R extends object>(
  router: R,
  ctx: unknown = {},
): Client<R> {
  const wrap = (node: unknown): unknown => {
    if (isProc(node)) {
      if (node.kind === "stream") {
        return (input: unknown) => invokeStream(node, input, ctx);
      }
      return (input: unknown) => invokeUnary(node, input, ctx);
    }
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(node as Record<string, unknown>)) {
      out[k] = wrap((node as Record<string, unknown>)[k]);
    }
    return out;
  };
  return wrap(router) as Client<R>;
}

function isProc(
  n: unknown,
): n is Proc<unknown, unknown, unknown, "unary" | "stream"> {
  return typeof n === "object" && n !== null && (n as { _nexus?: true })._nexus === true;
}
