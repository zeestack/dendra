// `createCaller` = "RPC with no HTTP". It walks the router and returns a typed
// facade whose methods invoke procedures in-process. This is what a Next Server
// Component calls for zero-round-trip data loading, and what the AI tool
// executor uses to run a tool. The `Client<R>` type below is the single mapped
// type that makes the whole framework typesafe with no codegen: it reads the
// router's shape and projects each procedure to a typed function.

import type { Proc, RouterRecord } from "./core.ts";
import { invokeStream, invokeUnary } from "./core.ts";

export type Client<R> = {
  // Match the ctx slot with `any` so the conditional fires regardless of the
  // concrete context type (ctx is contravariant in `handler`).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [K in keyof R]: R[K] extends Proc<any, infer In, infer Out, infer Kind>
    ? Kind extends "stream"
      ? (input: In) => AsyncIterable<Out>
      : (input: In) => Promise<Out>
    : R[K] extends RouterRecord
      ? Client<R[K]>
      : never;
};

export function createCaller<R extends RouterRecord>(
  router: R,
  ctx: unknown = {},
): Client<R> {
  const wrap = (node: AnyNode): unknown => {
    if (isProc(node)) {
      if (node.kind === "stream") {
        return (input: unknown) => invokeStream(node, input, ctx);
      }
      return (input: unknown) => invokeUnary(node, input, ctx);
    }
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(node)) out[k] = wrap(node[k]);
    return out;
  };
  return wrap(router) as Client<R>;
}

type AnyNode = RouterRecord | Proc<unknown, unknown, unknown, "unary" | "stream">;
function isProc(
  n: AnyNode,
): n is Proc<unknown, unknown, unknown, "unary" | "stream"> {
  return (n as { _nexus?: true })._nexus === true;
}
