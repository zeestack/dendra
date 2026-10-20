// `createCaller` = "RPC with no HTTP". It walks the router and returns a typed
// facade whose methods invoke procedures in-process. This is what a Next Server
// Component calls for zero-round-trip data loading, and what the AI tool
// executor uses to run a tool. The `Procedures` type below is the single mapped
// type that makes the whole framework typesafe with no codegen: it reads the
// router's shape and projects each procedure to a typed function — `Caller<R>`
// with the handler's own types, `Client<R>` with what survives JSON.

import type { Proc, ReadBrand } from "./core.ts";
import { invokeStream, invokeUnary } from "./core.ts";
import { isFileResult, toBlob, type FileResult } from "./files.ts";

/** Per-call options, the optional second argument of every procedure call. */
export interface CallOptions {
  /** Abort the call: a pending result rejects, and a stream ends, with the reason. */
  signal?: AbortSignal;
  /**
   * HTTP client with `batch: true` only: `false` sends this call on its own
   * (say, one you don't want sharing a request with others). Ignored elsewhere.
   */
  batch?: boolean;
}

// Recursion uses `object` (not the index-signature `RouterRecord`) so a class
// instance used as a sub-router — which has no index signature — still maps. A
// Proc is matched first; any other object recurses; primitives become `never`.
// `Wire` = results went through JSON, so their types are `Jsonify`d.
type Procedures<R, Wire extends boolean> = {
  // Match the ctx slot with `any` so the conditional fires regardless of the
  // concrete context type (ctx is contravariant in `handler`).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [K in keyof R]: R[K] extends Proc<any, infer In, infer Out, infer Kind>
    ? (Kind extends "stream"
        ? (input: In, opts?: CallOptions) => AsyncIterable<Result<Out, Wire>>
        : (input: In, opts?: CallOptions) => Promise<
            Out extends FileResult ? Blob : Result<Out, Wire>
          >) &
        (R[K] extends ReadBrand ? ReadBrand : unknown)
    : R[K] extends object
      ? Procedures<R[K], Wire>
      : never;
};

type Result<Out, Wire extends boolean> = Wire extends true ? Jsonify<Out> : Out;

/**
 * The typed client over a wire (`createClient`, `createWsClient`): results are
 * typed as what arrives after JSON — a `Date` is a `string`, see `Jsonify`.
 */
export type Client<R> = Procedures<R, true>;

/** The in-process caller (`createCaller`): results keep the handler's own types. */
export type Caller<R> = Procedures<R, false>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Fn = (...args: any[]) => unknown;
// Values JSON.stringify leaves out of objects (and turns into null in arrays).
type Dropped = undefined | symbol | Fn;

/**
 * The type a value has after `JSON.stringify` → `JSON.parse`. `toJSON` wins
 * (a `Date` becomes a `string`); `undefined`, function and symbol props are
 * dropped (`T | undefined` props become optional); in arrays they become
 * `null`; `Map`/`Set` become `{}`; class instances lose their methods.
 */
export type Jsonify<T> =
  // `any` stays `any`, `unknown` stays `unknown`.
  0 extends 1 & T
    ? T
    : unknown extends T
      ? unknown
      : JsonValue<T>;

type JsonValue<T> = T extends { toJSON(...args: never[]): infer J }
  ? Jsonify<J>
  : T extends string | number | boolean | null
    ? T
    : T extends Dropped | void
      ? undefined
      : T extends bigint // JSON.stringify throws on these
        ? never
        : T extends ReadonlyMap<unknown, unknown> | ReadonlySet<unknown>
          ? {}
          : T extends readonly unknown[]
            ? { [I in keyof T]: JsonElement<T[I]> }
            : T extends object
              ? JsonObject<T>
              : never;

// Distributes, so `string | undefined` elements become `string | null`.
type JsonElement<E> = E extends Dropped ? null : Jsonify<E>;

// Keys whose value can be left out: optional, or possibly undefined/a function.
type MaybeKeys<T> = {
  [K in keyof T]-?: string extends K
    ? never
    : number extends K
      ? never
      : {} extends Pick<T, K>
        ? K
        : [Extract<T[K], Dropped>] extends [never]
          ? never
          : K;
}[keyof T];

// Keys whose value is only ever dropped (undefined, a function, a symbol).
type GoneKeys<T> = {
  [K in keyof T]-?: [Exclude<T[K], Dropped>] extends [never] ? K : never;
}[keyof T];

type JsonObject<T> = Flatten<
  {
    [K in Exclude<keyof T, MaybeKeys<T> | GoneKeys<T> | symbol>]: Jsonify<T[K]>;
  } & {
    [K in Exclude<MaybeKeys<T>, GoneKeys<T> | symbol>]?: Jsonify<Exclude<T[K], Dropped>>;
  }
>;

type Flatten<T> = { [K in keyof T]: T[K] } & {};

export function createCaller<R extends object>(
  router: R,
  ctx: unknown = {},
): Caller<R> {
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
  return wrap(router, "") as Caller<R>;
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
