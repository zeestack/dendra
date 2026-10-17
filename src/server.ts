// The server adapter. `toFetchHandler` is the real, runtime-agnostic core: it
// speaks the Web Fetch `Request`/`Response` standard, so the SAME handler runs
// on Next route handlers, Hono, Bun, Deno and Cloudflare Workers. `toNodeHandler`
// is a thin bridge for the classic `node:http` server. Streaming responses use
// NDJSON over a Web ReadableStream, with a reserved error frame for failures
// that happen after headers are already sent.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { AnyProc, HttpMethod, RouterRecord } from "./core.ts";
import { invokeStream, invokeUnary, resolveProc } from "./core.ts";
import type { JSONSchema } from "./schema.ts";
import { DendraError } from "./errors.ts";

export interface ServerOptions<Ctx> {
  /** URL prefix that procedure paths live under. Default `/rpc/`. */
  prefix?: string;
  /** Build per-request context (auth, db handles, capabilities) from the request. */
  createContext?: (req: Request) => Ctx | Promise<Ctx>;
}

const enc = new TextEncoder();

export function toFetchHandler<Ctx>(
  router: object,
  opts: ServerOptions<Ctx> = {},
): (req: Request) => Promise<Response> {
  const root = router as RouterRecord;
  const prefix = opts.prefix ?? "/rpc/";
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (!url.pathname.startsWith(prefix)) {
      return jsonResponse(
        { error: { code: "NOT_FOUND", message: "No such route" } },
        404,
      );
    }
    const dotted = url.pathname.slice(prefix.length);

    let ctx: unknown = {};
    try {
      ctx = (await opts.createContext?.(req)) ?? {};
    } catch (e) {
      return errorToResponse(e);
    }

    // Batch: POST <prefix>__batch with [{ path, input }, ...] → [{ result }|{ error }, ...]
    // in the same order. One context for the whole batch; unary procedures only.
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
      const results = await Promise.all(
        calls.map(async (call) => {
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
              }),
            };
          } catch (e) {
            return { error: errorBody(e) };
          }
        }),
      );
      return jsonResponse(results, 200);
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

    let raw: unknown;
    try {
      if (req.method === "GET") {
        raw = Object.fromEntries(url.searchParams);
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

    const site = { path: dotted, transport: "rpc" as const };
    try {
      if (proc.kind === "stream") {
        return ndjsonResponse(invokeStream(proc, raw, ctx, site));
      }
      const result = await invokeUnary(proc, raw, ctx, site);
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
    const body = await readBody(req);
    // Tie an AbortSignal to the socket closing, so a client that disconnects
    // (or cancels a stream) aborts the request — handlers read `req.signal`
    // (via createContext) to stop subscriptions and long work.
    const controller = new AbortController();
    req.on("close", () => controller.abort());
    const request = new Request("http://localhost" + (req.url ?? "/"), {
      method,
      headers: req.headers as Record<string, string>,
      body:
        body.length && method !== "GET" && method !== "HEAD"
          ? body.toString("utf8")
          : undefined,
      signal: controller.signal,
    });
    const response = await handler(request);
    res.statusCode = response.status;
    response.headers.forEach((v, k) => res.setHeader(k, v));
    if (response.body) {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    }
    res.end();
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
    if (t === "number") {
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

    let ctx: unknown = {};
    try {
      ctx = (await opts.createContext?.(req)) ?? {};
    } catch (e) {
      return errorToResponse(e);
    }

    let body: Record<string, unknown> = {};
    if (method !== "GET") {
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
        return ndjsonResponse(invokeStream(matched.proc, input, ctx, site));
      }
      const result = await invokeUnary(matched.proc, input, ctx, site);
      return jsonResponse(result, 200);
    } catch (e) {
      return errorToResponse(e);
    }
  };
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function errorBody(e: unknown): {
  code: string;
  message: string;
  details?: unknown;
} {
  if (e instanceof DendraError) {
    return { code: e.code, message: e.message, details: e.details };
  }
  return {
    code: "INTERNAL",
    message: e instanceof Error ? e.message : "Internal error",
  };
}

function errorToResponse(e: unknown): Response {
  const status = e instanceof DendraError ? e.status : 500;
  return jsonResponse({ error: errorBody(e) }, status);
}

function ndjsonResponse(iterable: AsyncIterable<unknown>): Response {
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const chunk of iterable) {
          controller.enqueue(enc.encode(JSON.stringify(chunk) + "\n"));
        }
      } catch (e) {
        const err =
          e instanceof DendraError
            ? { code: e.code, message: e.message }
            : {
                code: "INTERNAL",
                message: e instanceof Error ? e.message : "stream error",
              };
        controller.enqueue(enc.encode(JSON.stringify({ $error: err }) + "\n"));
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "application/x-ndjson" },
  });
}
