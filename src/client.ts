// The client is a `Proxy` typed as the server's router — no generated files.
// Property access records a dotted path; calling it fires a request. The return
// value is a lazy object that is BOTH a Promise (so `await client.foo(x)` works
// for unary) AND an async-iterable (so `for await (...of client.bar(x))` works
// for streaming). TypeScript, via the `Client<R>` type, guides the caller to the
// right usage; the runtime object happens to support both.

import { abortable, type CallOptions, type Client } from "./caller.ts";
import type { ReadBrand } from "./core.ts";
import { DendraClientError } from "./errors.ts";

export interface ClientOptions {
  headers?: Record<string, string>;
  fetch?: typeof fetch;
  /** Must match the server's prefix. Default `/rpc/`. */
  prefix?: string;
  /**
   * Automatically batch unary calls made in the same tick into one HTTP request
   * (POST <prefix>__batch?p=a,b). Results stream back as each call settles, so a
   * slow call doesn't hold back the rest. Streaming calls and uploads always go
   * direct; pass `{ batch: false }` as a call's options to send it alone. Off by
   * default.
   */
  batch?: boolean;
  /**
   * Wire format for `.stream()` procedures: `"ndjson"` (default) or `"sse"`
   * (Server-Sent Events, which more proxies and CDNs pass through unbuffered).
   * Iteration, errors and cancellation work the same either way.
   */
  streamFormat?: "ndjson" | "sse";
}

// `X-Dendra` marks a request as coming from dendra's client. Browsers can't
// send a custom header cross-site without a CORS preflight, so the server uses
// it as CSRF proof on multipart uploads.
const jsonHeaders = { "content-type": "application/json", "x-dendra": "1" };

interface BatchReply {
  result?: unknown;
  error?: { code?: string; message?: string; details?: unknown };
}

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
    // Each call settles once, so the fallbacks below only reach calls the
    // response never answered.
    const settle = (c: BatchCall | undefined, r: BatchReply | undefined) => {
      if (!c || !r) return;
      if (r.error) c.reject(new DendraClientError(r.error));
      else c.resolve(r.result);
    };
    try {
      // `?p=` names the procedures, so logs, rate limits and network mocks
      // can still tell batched calls apart.
      const names = calls.map((c) => encodeURIComponent(c.path)).join(",");
      const res = await doFetch(base + prefix + "__batch?p=" + names, {
        method: "POST",
        headers: { ...jsonHeaders, accept: "application/x-ndjson", ...(opts.headers ?? {}) },
        body: JSON.stringify(calls.map((c) => ({ path: c.path, input: c.input ?? null }))),
      });
      if (res.body && res.headers.get("content-type")?.startsWith("application/x-ndjson")) {
        // One line per call, in the order they settle on the server.
        for await (const line of readNdjson(res.body)) {
          const r = line as BatchReply & { i: number };
          settle(calls[r.i], r);
        }
      } else {
        // An older server answers with the whole array; a failed request (e.g.
        // createContext threw) with a single error envelope.
        const data = (await res.json()) as BatchReply[] | BatchReply;
        if (Array.isArray(data)) calls.forEach((c, i) => settle(c, data[i]));
        else for (const c of calls) settle(c, data);
      }
    } catch (e) {
      for (const c of calls) c.reject(e);
    }
    const missing = { code: "INTERNAL", message: "The batch response had no result for this call" };
    for (const c of calls) c.reject(new DendraClientError(missing));
  };
  const enqueue = (path: string, input: unknown) =>
    new Promise<unknown>((resolve, reject) => {
      queue.push({ path, input, resolve, reject });
      if (!scheduled) {
        scheduled = true;
        // A macrotask, not a microtask: `await call` reaches `.then` a microtask
        // late, so a microtask flush would split one tick across two batches.
        setTimeout(flush, 0);
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
        const call = (args[1] ?? {}) as CallOptions;
        // Uploads go direct: a batch is one JSON body, which can't carry files.
        const batchUnary =
          opts.batch && call.batch !== false && !hasBlob(args[0])
            ? (input: unknown) => enqueue(dotted, input)
            : undefined;
        const { signal } = call;
        const accept = opts.streamFormat === "sse" ? "text/event-stream" : "application/x-ndjson";
        return lazyCall(doFetch, url, args[0], opts.headers, batchUnary, signal, accept);
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
  signal?: AbortSignal,
  streamAccept?: string,
) {
  const start = (accept?: Record<string, string>) => {
    signal?.throwIfAborted();
    return doFetch(
      url,
      hasBlob(input)
        ? {
            // No content-type: fetch sets multipart/form-data with its boundary.
            method: "POST",
            headers: { "x-dendra": "1", ...accept, ...(headers ?? {}) },
            body: toFormData(input as Record<string, unknown>),
            signal,
          }
        : {
            method: "POST",
            headers: { ...jsonHeaders, ...accept, ...(headers ?? {}) },
            body: JSON.stringify(input ?? null),
            signal,
          },
    );
  };

  return new Call(
    // Unary path: awaiting the call reads a single JSON envelope — or joins the
    // batch when batching is enabled.
    async () => {
      // A batched call can't be pulled out of the batch, so an abort just stops
      // waiting for it; a direct call's fetch is aborted too.
      signal?.throwIfAborted();
      if (batchUnary) return abortable(batchUnary(input), signal);
      return abortable(
        start().then(async (res) => {
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
        signal,
      );
    },
    // Streaming path: iterating the call reads NDJSON or SSE frames, whichever
    // the server answered with. Breaking out of the `for await` (or aborting
    // the signal) cancels the body — closing the connection so the server can
    // tear the subscription down. An abort then ends the loop by throwing the
    // signal's reason.
    async function* () {
      const res = await start(streamAccept ? { accept: streamAccept } : undefined);
      const body = res.body;
      if (!body) return;
      const type = res.headers.get("content-type") ?? "";
      try {
        // A request that failed before streaming (e.g. createContext threw)
        // answers with a plain JSON error envelope.
        if (type.startsWith("application/json")) {
          const data = (await res.json()) as { error?: { code?: string; message?: string } };
          throw new DendraClientError(data.error ?? {});
        }
        if (type.startsWith("text/event-stream")) {
          for await (const ev of readSse(body, signal)) {
            if (ev.event === "error") throw new DendraClientError(JSON.parse(ev.data));
            if (ev.event === "done") return;
            yield JSON.parse(ev.data);
          }
        } else {
          for await (const obj of readNdjson(body, signal)) {
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
        }
        signal?.throwIfAborted();
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
  signal?: AbortSignal,
): AsyncIterable<unknown> {
  for await (const raw of readLines(body, signal)) {
    const line = raw.trim();
    if (line) yield JSON.parse(line);
  }
}

// Server-Sent Events: `event:`/`data:` fields up to a blank line make one
// event. Comments (`: ping` heartbeats), `id:` and `retry:` are skipped.
async function* readSse(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncIterable<{ event: string; data: string }> {
  let event = "";
  let data: string[] = [];
  for await (const raw of readLines(body, signal)) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line === "") {
      if (data.length) yield { event, data: data.join("\n") };
      event = "";
      data = [];
      continue;
    }
    const colon = line.indexOf(":");
    if (colon === 0) continue;
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
}

async function* readLines(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncIterable<string> {
  const reader = body.getReader();
  // Cancelling ends a pending read with `done`, whatever the fetch did.
  const onAbort = () => void reader.cancel(signal?.reason).catch(() => {});
  signal?.addEventListener("abort", onAbort, { once: true });
  const dec = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        yield buf.slice(0, idx);
        buf = buf.slice(idx + 1);
      }
    }
    if (buf) yield buf;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}
