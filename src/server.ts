// The server adapter. `toFetchHandler` is the real, runtime-agnostic core: it
// speaks the Web Fetch `Request`/`Response` standard, so the SAME handler runs
// on Next route handlers, Hono, Bun, Deno and Cloudflare Workers. `toNodeHandler`
// is a thin bridge for the classic `node:http` server. Streaming responses use
// NDJSON over a Web ReadableStream (or Server-Sent Events when the client
// accepts `text/event-stream`), with a reserved error frame for failures that
// happen after headers are already sent.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { AnyProc, CallSite, HttpMethod, RouterRecord } from "./core.ts";
import { invokeStream, invokeUnary, resolveProc } from "./core.ts";
import type { JSONSchema } from "./schema.ts";
import { DendraError, publicError } from "./errors.ts";
import { DEFAULT_MAX_BODY_BYTES, fileResponse, isFileResult, readFormInput } from "./files.ts";

export interface ServerOptions<Ctx> {
  /** URL prefix that procedure paths live under. Default `/rpc/`. */
  prefix?: string;
  /** Build per-request context (auth, db handles, capabilities) from the request. */
  createContext?: (req: Request) => Ctx | Promise<Ctx>;
  /**
   * Accept plain HTML form posts (urlencoded, or multipart without dendra's
   * `X-Dendra` header). Off by default: browsers send these cross-site with no
   * preflight, so turning this on makes CSRF protection the app's job (e.g. a
   * token checked in `.use()`).
   */
  allowFormPosts?: boolean;
  /** Cap on multipart / form request bodies, in bytes. Default 10 MB. */
  maxBodyBytes?: number;
  /**
   * How often an idle SSE stream sends a `: ping` comment, so proxies and load
   * balancers don't close it. Default 15 s; `0` turns heartbeats off.
   */
  heartbeatMs?: number;
}

// CSRF guard for POST. A cross-site page can only send "simple" requests
// without a CORS preflight: GET, or POST with a form/text content type (or none
// at all). So a POST must be JSON, or multipart carrying the `X-Dendra` header
// the typed client always sends (a custom header forces a preflight) — anything
// else could have come from another site riding the user's cookies. Returns the
// rejection, or undefined when the request may proceed.
export function csrfReject(req: Request, opts: ServerOptions<unknown>): Response | undefined {
  const type = mediaType(req);
  if (type === "application/json") return undefined;
  if (opts.allowFormPosts && isFormType(type)) return undefined;
  if (type === "multipart/form-data") {
    if (req.headers.get("x-dendra") === "1") return undefined;
    return jsonResponse(
      {
        error: {
          code: "FORBIDDEN",
          message: "Multipart requests need the X-Dendra: 1 header (or allowFormPosts)",
        },
      },
      403,
    );
  }
  return jsonResponse(
    {
      error: {
        code: "UNSUPPORTED_MEDIA_TYPE",
        message: "Send JSON (Content-Type: application/json)",
      },
    },
    415,
  );
}

function isFormType(type: string): boolean {
  return type === "multipart/form-data" || type === "application/x-www-form-urlencoded";
}

function mediaType(req: Request): string {
  return (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
}

const enc = new TextEncoder();

export function toFetchHandler<Ctx>(
  router: object,
  opts: ServerOptions<Ctx> = {},
): (req: Request) => Promise<Response> {
  const root = router as RouterRecord;
  const prefix = opts.prefix ?? "/rpc/";
  const maxBody = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (!url.pathname.startsWith(prefix)) {
      return jsonResponse(
        { error: { code: "NOT_FOUND", message: "No such route" } },
        404,
      );
    }
    const dotted = url.pathname.slice(prefix.length);
    if (req.method === "POST") {
      const rejected = csrfReject(req, opts as ServerOptions<unknown>);
      if (rejected) return rejected;
    }

    let ctx: unknown = {};
    try {
      ctx = (await opts.createContext?.(req)) ?? {};
    } catch (e) {
      return errorToResponse(e);
    }

    // Batch: POST <prefix>__batch with [{ path, input }, ...]. A client that
    // accepts NDJSON gets one `{ i, result }|{ i, error }` line per call as it
    // settles, so a slow call never holds back a quick one; otherwise the reply
    // is the whole `[{ result }|{ error }, ...]` array, in order. One context
    // for the whole batch; unary procedures only. (`?p=` names the procedures
    // for logs and mocks; the server doesn't need it.)
    if (dotted === "__batch") {
      let calls: Array<{ path: string; input?: unknown }>;
      try {
        calls = JSON.parse(await req.text());
        if (!Array.isArray(calls)) throw new Error("not an array");
      } catch {
        return jsonResponse(
          { error: { code: "BAD_REQUEST", message: "Batch body must be an array" } },
          400,
        );
      }
      const settled = calls.map(async (call): Promise<BatchResult> => {
        const p = resolveProc(root, (call.path ?? "").split(".").filter(Boolean));
        if (!p || p.kind !== "unary") {
          return {
            error: {
              code: "NOT_FOUND",
              message: `Procedure '${call.path}' not found (or not unary)`,
            },
          };
        }
        try {
          return {
            result: await invokeUnary(p, call.input, ctx, {
              path: call.path,
              transport: "rpc",
              batch: true,
            }),
          };
        } catch (e) {
          return { error: errorBody(e) };
        }
      });
      if ((req.headers.get("accept") ?? "").includes("application/x-ndjson")) {
        return ndjsonResponse(inSettleOrder(settled), () => {});
      }
      return jsonResponse(await Promise.all(settled), 200);
    }

    const proc = resolveProc(root, dotted.split(".").filter(Boolean));
    if (!proc) {
      return jsonResponse(
        {
          error: {
            code: "NOT_FOUND",
            message: `Procedure '${dotted}' not found`,
          },
        },
        404,
      );
    }
    // POST reaches anything; GET/HEAD (no preflight, embeddable) only reads.
    // Anything else (PUT, DELETE, …) isn't part of the RPC protocol.
    const readish = req.method === "GET" || req.method === "HEAD";
    if (req.method !== "POST" && !(readish && proc.method === "GET")) {
      return jsonResponse(
        {
          error: {
            code: "METHOD_NOT_ALLOWED",
            message: `'${dotted}' isn't a read; call it with POST (declare reads with .get())`,
          },
        },
        405,
      );
    }

    let raw: unknown;
    if (isFormType(mediaType(req))) {
      // Uploads and form posts: string fields get the same coercion as REST.
      try {
        raw = coerceInput(proc, await readFormInput(req, maxBody));
      } catch (e) {
        return errorToResponse(e);
      }
    } else {
      try {
        if (readish) {
          // `$input` (from urlFor) carries typed JSON; otherwise flat strings.
          const json = url.searchParams.get("$input");
          raw = json !== null ? JSON.parse(json) : Object.fromEntries(url.searchParams);
        } else {
          const text = await req.text();
          raw = text ? JSON.parse(text) : undefined;
        }
      } catch {
        return jsonResponse(
          { error: { code: "BAD_REQUEST", message: "Invalid JSON body" } },
          400,
        );
      }
    }

    const site = { path: dotted, transport: "rpc" as const };
    try {
      if (proc.kind === "stream") {
        return streamResponse(proc, raw, ctx, site, req, opts);
      }
      const result = await invokeUnary(proc, raw, ctx, site);
      if (isFileResult(result)) return fileResponse(result, req);
      return jsonResponse({ result }, 200);
    } catch (e) {
      return errorToResponse(e);
    }
  };
}

export function toNodeHandler<Ctx>(
  router: object,
  opts: ServerOptions<Ctx> = {},
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const handler = toFetchHandler(router, opts);
  return async (req: IncomingMessage, res: ServerResponse) => {
    const method = req.method ?? "GET";
    // Tie an AbortSignal to the client going away, so a disconnect (or a
    // cancelled stream) aborts the request and stops subscriptions. Listen on
    // `res`, not `req`: since Node 16 `req` "close" fires once the body has been
    // read, while the response may still be streaming.
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) controller.abort();
    });
    const request = new Request("http://localhost" + (req.url ?? "/"), {
      method,
      headers: req.headers as Record<string, string>,
      // Stream the body through (bytes untouched, so binary uploads survive) and
      // let the fetch handler's cap stop reading early — no buffering here.
      body: method !== "GET" && method !== "HEAD" ? bodyStream(req) : undefined,
      duplex: "half",
      signal: controller.signal,
    } as RequestInit);
    const response = await handler(request);
    res.statusCode = response.status;
    response.headers.forEach((v, k) => res.setHeader(k, v));
    if (response.body) {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
        // Compression middleware (Express `compression`) buffers until flushed.
        (res as { flush?: () => void }).flush?.();
      }
    }
    res.end();
    req.emit("dendra:responded");
  };
}

// ---------------------------------------------------------------------------
// REST front-end. Procedures that declared a `.get('/users/:id')` style path are
// matched by method + path, with params extracted and merged with query/body.
// It shares the exact same dispatch core as RPC — it is just a second doorway,
// returning the result directly (not RPC's `{ result }` envelope) so it reads
// like a normal REST API and lines up with the OpenAPI document.
// ---------------------------------------------------------------------------

interface RestRoute {
  method: HttpMethod;
  regex: RegExp;
  paramNames: string[];
  proc: AnyProc;
  name: string; // dotted router path, e.g. "notes.get"
}

function buildRestTable(router: RouterRecord): RestRoute[] {
  const routes: RestRoute[] = [];
  const walk = (node: RouterRecord, prefix: string): void => {
    for (const k of Object.keys(node)) {
      const child = node[k];
      const name = prefix ? `${prefix}.${k}` : k;
      if ((child as AnyProc)._dendra) {
        const proc = child as AnyProc;
        if (proc.path) {
          const paramNames: string[] = [];
          const pattern = proc.path.replace(/:([A-Za-z0-9_]+)/g, (_m, name) => {
            paramNames.push(name);
            return "([^/]+)";
          });
          routes.push({
            method: proc.method,
            regex: new RegExp("^" + pattern + "/?$"),
            paramNames,
            proc,
            name,
          });
        }
      } else {
        walk(child as RouterRecord, name);
      }
    }
  };
  walk(router, "");
  return routes;
}

function coerceInput(
  proc: AnyProc,
  obj: Record<string, unknown>,
): Record<string, unknown> {
  const props = proc.inputJsonSchema?.properties;
  if (!props) return obj;
  const out = { ...obj };
  for (const [k, v] of Object.entries(out)) {
    if (typeof v !== "string") continue;
    const t = (props[k] as JSONSchema | undefined)?.type;
    if (t === "number" || t === "integer") {
      const n = Number(v);
      if (!Number.isNaN(n)) out[k] = n;
    } else if (t === "boolean") {
      out[k] = v === "true";
    }
  }
  return out;
}

export function toRestHandler<Ctx>(
  router: object,
  opts: ServerOptions<Ctx> = {},
): (req: Request) => Promise<Response> {
  const table = buildRestTable(router as RouterRecord);
  const base = opts.prefix ?? "";
  const maxBody = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const method = (req.method ?? "GET") as HttpMethod;
    let pathname = url.pathname;
    if (base && pathname.startsWith(base)) {
      pathname = pathname.slice(base.length) || "/";
    }

    let matched: RestRoute | undefined;
    let m: RegExpExecArray | null = null;
    for (const route of table) {
      if (route.method !== method) continue;
      const exec = route.regex.exec(pathname);
      if (exec) {
        matched = route;
        m = exec;
        break;
      }
    }
    if (!matched || !m) {
      return jsonResponse(
        {
          error: {
            code: "NOT_FOUND",
            message: `No route for ${method} ${pathname}`,
          },
        },
        404,
      );
    }

    const params: Record<string, string> = {};
    matched.paramNames.forEach((name, i) => {
      params[name] = decodeURIComponent(m![i + 1]);
    });

    // PUT/PATCH/DELETE always preflight cross-site, so only POST needs the guard.
    if (method === "POST") {
      const rejected = csrfReject(req, opts as ServerOptions<unknown>);
      if (rejected) return rejected;
    }

    let ctx: unknown = {};
    try {
      ctx = (await opts.createContext?.(req)) ?? {};
    } catch (e) {
      return errorToResponse(e);
    }

    let body: Record<string, unknown> = {};
    if (isFormType(mediaType(req))) {
      try {
        body = await readFormInput(req, maxBody);
      } catch (e) {
        return errorToResponse(e);
      }
    } else if (method !== "GET") {
      try {
        const text = await req.text();
        if (text) body = JSON.parse(text) as Record<string, unknown>;
      } catch {
        return jsonResponse(
          { error: { code: "BAD_REQUEST", message: "Invalid JSON body" } },
          400,
        );
      }
    }

    const query = Object.fromEntries(url.searchParams);
    const input = coerceInput(matched.proc, { ...body, ...query, ...params });

    const site = { path: matched.name, transport: "rest" as const };
    try {
      if (matched.proc.kind === "stream") {
        return streamResponse(matched.proc, input, ctx, site, req, opts);
      }
      const result = await invokeUnary(matched.proc, input, ctx, site);
      if (isFileResult(result)) return fileResponse(result, req);
      return jsonResponse(result, 200);
    } catch (e) {
      return errorToResponse(e);
    }
  };
}

// A Web stream over a Node request, with backpressure. Whatever isn't read —
// the rest of an upload past the body cap, or a body an early 4xx never looked
// at — is drained and discarded once the response is written, rather than
// destroying the socket, so the response gets through and keep-alive keeps
// working. (Cancelling the Request's body doesn't reach this stream: undici
// wraps it.) `done` guards the late "end" — closing twice would throw.
function bodyStream(req: IncomingMessage): ReadableStream<Uint8Array> {
  let done = false;
  const discard = () => {
    done = true;
    req.removeAllListeners("data");
    req.resume();
  };
  return new ReadableStream<Uint8Array>({
    start(controller) {
      req.on("data", (c: Buffer) => {
        controller.enqueue(new Uint8Array(c.buffer, c.byteOffset, c.byteLength));
        if ((controller.desiredSize ?? 1) <= 0) req.pause();
      });
      req.on("end", () => {
        if (!done) controller.close();
        done = true;
      });
      req.on("error", (e) => {
        if (!done) controller.error(e);
        done = true;
      });
      // Once the response is written, nothing will read the body any more.
      req.once("dendra:responded", discard);
    },
    pull() {
      req.resume();
    },
    cancel: discard,
  });
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// An unexpected error reaches the client as a bare INTERNAL (its message can
// carry internals); the original is logged here so it isn't lost.
function errorBody(e: unknown): ReturnType<typeof publicError> {
  if (!(e instanceof DendraError)) console.error("[dendra] unexpected error:", e);
  return publicError(e);
}

function errorToResponse(e: unknown): Response {
  const status = e instanceof DendraError ? e.status : 500;
  return jsonResponse({ error: errorBody(e) }, status);
}

type BatchResult = { result: unknown } | { error: ReturnType<typeof errorBody> };

// Yield each batch result, tagged with its index, as soon as it settles.
async function* inSettleOrder(
  settled: Promise<BatchResult>[],
): AsyncIterable<{ i: number } & BatchResult> {
  const pending = new Map(settled.map((p, i) => [i, p.then((r) => ({ i, ...r }))]));
  while (pending.size) {
    const next = await Promise.race(pending.values());
    pending.delete(next.i);
    yield next;
  }
}

// A stream ends when the request is aborted (the runtime noticed the client
// leave) or the response body is cancelled (the reader stopped) — whichever
// comes first aborts the handler's signal. The wire format follows `Accept`:
// SSE for `text/event-stream`, NDJSON otherwise.
function streamResponse(
  proc: AnyProc,
  raw: unknown,
  ctx: unknown,
  site: CallSite,
  req: Request,
  opts: ServerOptions<unknown>,
): Response {
  const ac = new AbortController();
  const stop = () => ac.abort();
  if (req.signal.aborted) stop();
  else req.signal.addEventListener("abort", stop, { once: true });
  const frames = invokeStream(proc, raw, ctx, { ...site, signal: ac.signal });
  const onCancel = () => {
    req.signal.removeEventListener("abort", stop);
    stop();
  };
  if ((req.headers.get("accept") ?? "").includes("text/event-stream")) {
    return sseResponse(frames, onCancel, opts.heartbeatMs ?? 15_000);
  }
  return ndjsonResponse(frames, onCancel);
}

// Streamed responses must reach the client as they're written: `no-cache`
// stops caches holding them, and `X-Accel-Buffering: no` turns off nginx's
// response buffering for this response.
const streamHeaders = { "cache-control": "no-cache", "x-accel-buffering": "no" };

function streamError(e: unknown): { code: string; message: string } {
  const { code, message } = errorBody(e);
  return { code, message };
}

// Pull-based, so a slow reader applies backpressure to the generator. On
// cancel, `onCancel` aborts the handler (waking a subscription that's waiting
// on its signal) and `return()` ends the generator, running its `finally`.
function ndjsonResponse(iterable: AsyncIterable<unknown>, onCancel: () => void): Response {
  const it = iterable[Symbol.asyncIterator]();
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await it.next();
        if (cancelled) return;
        if (done) controller.close();
        else controller.enqueue(enc.encode(JSON.stringify(value) + "\n"));
      } catch (e) {
        if (cancelled) return;
        controller.enqueue(enc.encode(JSON.stringify({ $error: streamError(e) }) + "\n"));
        controller.close();
      }
    },
    async cancel() {
      cancelled = true;
      onCancel();
      await it.return?.();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "application/x-ndjson", ...streamHeaders },
  });
}

// The same stream as Server-Sent Events: each value is a `data:` event, a
// failure is an `error` event carrying `{ code, message }`, and a normal end is
// a `done` event — so an `EventSource` can close() instead of reconnecting and
// re-running the subscription. While the handler is idle, a `: ping` comment
// goes out every `heartbeatMs`.
function sseResponse(
  iterable: AsyncIterable<unknown>,
  onCancel: () => void,
  heartbeatMs: number,
): Response {
  const it = iterable[Symbol.asyncIterator]();
  let cancelled = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const event = (name: string, data: unknown) =>
    enc.encode((name ? `event: ${name}\n` : "") + `data: ${JSON.stringify(data)}\n\n`);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (heartbeatMs > 0) {
        heartbeat = setInterval(() => controller.enqueue(enc.encode(": ping\n\n")), heartbeatMs);
      }
    },
    async pull(controller) {
      try {
        const { done, value } = await it.next();
        if (cancelled) return;
        if (done) {
          clearInterval(heartbeat);
          controller.enqueue(event("done", null));
          controller.close();
        } else controller.enqueue(event("", value ?? null));
      } catch (e) {
        if (cancelled) return;
        clearInterval(heartbeat);
        controller.enqueue(event("error", streamError(e)));
        controller.close();
      }
    },
    async cancel() {
      cancelled = true;
      clearInterval(heartbeat);
      onCancel();
      await it.return?.();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream", ...streamHeaders },
  });
}
