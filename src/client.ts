// The client is a `Proxy` typed as the server's router — no generated files.
// Property access records a dotted path; calling it fires a request. The return
// value is a lazy object that is BOTH a Promise (so `await client.foo(x)` works
// for unary) AND an async-iterable (so `for await (...of client.bar(x))` works
// for streaming). TypeScript, via the `Client<R>` type, guides the caller to the
// right usage; the runtime object happens to support both.

import type { Client } from "./caller.ts";
import type { ReadBrand } from "./core.ts";
import { DendraClientError } from "./errors.ts";

export interface ClientOptions {
  headers?: Record<string, string>;
  fetch?: typeof fetch;
  /** Must match the server's prefix. Default `/rpc/`. */
  prefix?: string;
  /**
   * Automatically batch unary calls made in the same tick into one HTTP request
   * (POST <prefix>__batch). Streaming calls always go direct. Off by default.
   */
  batch?: boolean;
}

// `X-Dendra` marks a request as coming from dendra's client. Browsers can't
// send a custom header cross-site without a CORS preflight, so the server uses
// it as CSRF proof on multipart uploads.
const jsonHeaders = { "content-type": "application/json", "x-dendra": "1" };

interface BatchCall {
  path: string;
  input: unknown;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

export function createClient<R extends object>(
  baseUrl: string,
  opts: ClientOptions = {},
): Client<R> {
  const prefix = opts.prefix ?? "/rpc/";
  const doFetch = opts.fetch ?? fetch;
  const base = baseUrl.replace(/\/$/, "");

  // --- optional unary batching -------------------------------------------
  let queue: BatchCall[] = [];
  let scheduled = false;
  const flush = async () => {
    const calls = queue;
    queue = [];
    scheduled = false;
    try {
      const res = await doFetch(base + prefix + "__batch", {
        method: "POST",
        headers: { ...jsonHeaders, ...(opts.headers ?? {}) },
        body: JSON.stringify(calls.map((c) => ({ path: c.path, input: c.input ?? null }))),
      });
      const data = (await res.json()) as Array<{
        result?: unknown;
        error?: { code?: string; message?: string; details?: unknown };
      }>;
      calls.forEach((c, i) => {
        const r = data[i];
        if (r && r.error) c.reject(new DendraClientError(r.error));
        else c.resolve(r ? r.result : undefined);
      });
    } catch (e) {
      for (const c of calls) c.reject(e);
    }
  };
  const enqueue = (path: string, input: unknown) =>
    new Promise<unknown>((resolve, reject) => {
      queue.push({ path, input, resolve, reject });
      if (!scheduled) {
        scheduled = true;
        queueMicrotask(flush);
      }
    });
  // -----------------------------------------------------------------------

  const build = (path: string[]): unknown =>
    new Proxy(noop, {
      get(_t, key) {
        // Keep the path-proxy itself non-thenable / non-iterable; only the
        // object returned from a call is.
        if (key === URL_OF) {
          return (input: unknown) =>
            base + prefix + path.join(".") + "?$input=" + encodeURIComponent(JSON.stringify(input ?? null));
        }
        if (typeof key !== "string" || key === "then") return undefined;
        return build([...path, key]);
      },
      apply(_t, _this, args: unknown[]) {
        const dotted = path.join(".");
        const url = base + prefix + dotted;
        // Uploads go direct: a batch is one JSON body, which can't carry files.
        const batchUnary =
          opts.batch && !hasBlob(args[0])
            ? (input: unknown) => enqueue(dotted, input)
            : undefined;
        return lazyCall(doFetch, url, args[0], opts.headers, batchUnary);
      },
    });

  return build([]) as Client<R>;
}

function noop(): void {}

// A symbol, not a property name, so it can't collide with a router key.
const URL_OF = Symbol("dendra.urlOf");

/**
 * The GET URL for a read — for `<img src>`, download links, or prefetching.
 * Only procedures declared `.get()` qualify (a type error otherwise, and a 405
 * from the server): a URL anyone can embed must never trigger a mutation.
 */
export function urlFor<In>(
  procedure: ((input: In) => Promise<unknown>) & ReadBrand,
  input: In,
): string {
  const build = (procedure as unknown as Record<symbol, unknown>)[URL_OF];
  if (typeof build !== "function") {
    throw new TypeError("urlFor expects a procedure from createClient");
  }
  return (build as (input: unknown) => string)(input);
}

// True when a top-level input field is a File/Blob — the call goes multipart.
function hasBlob(input: unknown): boolean {
  return (
    typeof input === "object" &&
    input !== null &&
    Object.values(input).some((v) => typeof Blob !== "undefined" && v instanceof Blob)
  );
}

// Files become their own parts; everything else rides in one JSON part,
// `$input`, so numbers, booleans and nested objects keep their types.
function toFormData(input: Record<string, unknown>): FormData {
  const fd = new FormData();
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v instanceof Blob) fd.append(k, v);
    else rest[k] = v;
  }
  fd.set("$input", JSON.stringify(rest));
  return fd;
}

function lazyCall(
  doFetch: typeof fetch,
  url: string,
  input: unknown,
  headers?: Record<string, string>,
  batchUnary?: (input: unknown) => Promise<unknown>,
) {
  const start = () =>
    doFetch(
      url,
      hasBlob(input)
        ? {
            // No content-type: fetch sets multipart/form-data with its boundary.
            method: "POST",
            headers: { "x-dendra": "1", ...(headers ?? {}) },
            body: toFormData(input as Record<string, unknown>),
          }
        : {
            method: "POST",
            headers: { ...jsonHeaders, ...(headers ?? {}) },
            body: JSON.stringify(input ?? null),
          },
    );

  return new Call(
    // Unary path: awaiting the call reads a single JSON envelope — or joins the
    // batch when batching is enabled.
    () =>
      batchUnary
        ? batchUnary(input)
        : start().then(async (res) => {
            // A file response is the raw bytes, flagged by X-Dendra (not the
            // content type — a downloaded file can itself be JSON).
            if (res.ok && res.headers.get("x-dendra") === "file") return res.blob();
            const data = (await res.json()) as {
              result?: unknown;
              error?: { code?: string; message?: string; details?: unknown };
            };
            if (data.error) throw new DendraClientError(data.error);
            return data.result;
          }),
    // Streaming path: iterating the call reads NDJSON frames. Breaking out of
    // the `for await` runs the `finally`, which cancels the body — closing the
    // connection so the server can tear the subscription down.
    async function* () {
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
            throw new DendraClientError(
              (obj as { $error: { code?: string; message?: string } }).$error,
            );
          }
          yield obj;
        }
      } finally {
        await body.cancel().catch(() => {});
      }
    },
  );
}

// A call is a real Promise (so `.catch`, `.finally`, `Promise.race` and
// `instanceof Promise` all work) that is ALSO async-iterable. It stays lazy:
// nothing is sent until the first `.then` (which `await`, `.catch` and
// `.finally` all go through) or until it's iterated — so iterating a stream
// never fires the unary request too.
class Call extends Promise<unknown> {
  // Derived promises (`.then(...)` results) are plain Promises, not Calls.
  static get [Symbol.species]() {
    return Promise;
  }
  #run?: () => Promise<unknown>;
  #settle?: [(v: unknown) => void, (e: unknown) => void];
  #iterate: () => AsyncIterator<unknown>;

  constructor(run: () => Promise<unknown>, iterate: () => AsyncIterator<unknown>) {
    let settle!: [(v: unknown) => void, (e: unknown) => void];
    super((resolve, reject) => {
      settle = [resolve, reject];
    });
    this.#run = run;
    this.#settle = settle;
    this.#iterate = iterate;
  }

  override then<TResult1 = unknown, TResult2 = never>(
    onFulfilled?: ((value: unknown) => TResult1 | PromiseLike<TResult1>) | null,
    onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    const run = this.#run;
    if (run) {
      const [resolve, reject] = this.#settle!;
      this.#run = this.#settle = undefined;
      run().then(resolve, reject);
    }
    return super.then(onFulfilled, onRejected);
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return this.#iterate();
  }
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
