// The client is a `Proxy` typed as the server's router — no generated files.
// Property access records a dotted path; calling it fires a request. The return
// value is a lazy object that is BOTH a thenable (so `await client.foo(x)` works
// for unary) AND an async-iterable (so `for await (...of client.bar(x))` works
// for streaming). TypeScript, via the `Client<R>` type, guides the caller to the
// right usage; the runtime object happens to support both.

import type { Client } from "./caller.ts";
import type { RouterRecord } from "./core.ts";
import { NexusClientError } from "./errors.ts";

export interface ClientOptions {
  headers?: Record<string, string>;
  fetch?: typeof fetch;
  /** Must match the server's prefix. Default `/rpc/`. */
  prefix?: string;
}

export function createClient<R extends RouterRecord>(
  baseUrl: string,
  opts: ClientOptions = {},
): Client<R> {
  const prefix = opts.prefix ?? "/rpc/";
  const doFetch = opts.fetch ?? fetch;
  const base = baseUrl.replace(/\/$/, "");

  const build = (path: string[]): unknown =>
    new Proxy(noop, {
      get(_t, key) {
        // Keep the path-proxy itself non-thenable / non-iterable; only the
        // object returned from a call is.
        if (typeof key !== "string" || key === "then") return undefined;
        return build([...path, key]);
      },
      apply(_t, _this, args: unknown[]) {
        const url = base + prefix + path.join(".");
        return lazyCall(doFetch, url, args[0], opts.headers);
      },
    });

  return build([]) as Client<R>;
}

function noop(): void {}

function lazyCall(
  doFetch: typeof fetch,
  url: string,
  input: unknown,
  headers?: Record<string, string>,
) {
  const start = () =>
    doFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(headers ?? {}) },
      body: JSON.stringify(input ?? null),
    });

  return {
    // Unary path: awaiting the call reads a single JSON envelope.
    then<TResult1 = unknown, TResult2 = never>(
      onFulfilled?:
        | ((value: unknown) => TResult1 | PromiseLike<TResult1>)
        | null,
      onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): Promise<TResult1 | TResult2> {
      return start()
        .then(async (res) => {
          const data = (await res.json()) as {
            result?: unknown;
            error?: { code?: string; message?: string; details?: unknown };
          };
          if (data.error) throw new NexusClientError(data.error);
          return data.result;
        })
        .then(onFulfilled, onRejected);
    },
    // Streaming path: iterating the call reads NDJSON frames. Breaking out of
    // the `for await` runs the `finally`, which cancels the body — closing the
    // connection so the server can tear the subscription down.
    async *[Symbol.asyncIterator]() {
      const res = await start();
      const body = res.body;
      if (!body) return;
      try {
        for await (const obj of readNdjson(body)) {
          if (
            obj &&
            typeof obj === "object" &&
            "$error" in (obj as Record<string, unknown>)
          ) {
            throw new NexusClientError(
              (obj as { $error: { code?: string; message?: string } }).$error,
            );
          }
          yield obj;
        }
      } finally {
        await body.cancel().catch(() => {});
      }
    },
  };
}

async function* readNdjson(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<unknown> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line) yield JSON.parse(line);
    }
  }
  const last = buf.trim();
  if (last) yield JSON.parse(last);
}
