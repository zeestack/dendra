// WebSocket transport. True bidirectional, low-latency real-time — live cursors,
// multiplayer, high-frequency updates — multiplexed over ONE socket. The
// procedures don't change at all; this is just another adapter over the same
// dispatch core. Both the server session and the typed client are written
// transport-agnostically (they take a `send` and are fed raw messages), so they
// run over the `ws` package, Bun/Deno/Cloudflare sockets, or an in-memory
// loopback — and are trivially testable without a network.
//
// Note: Next.js serverless cannot host a long-lived socket. Run `createWsSession`
// in a standalone Node/Bun process (the same router, zero rewrite) — this is why
// the core stays runtime-agnostic.

import type { Client } from "./caller.ts";
import type { RouterRecord } from "./core.ts";
import { invokeStream, invokeUnary, resolveProc } from "./core.ts";
import { DendraClientError, DendraError, publicError } from "./errors.ts";

type ClientMsg =
  | { id: number; type: "call"; path: string; input?: unknown }
  | { id: number; type: "subscribe"; path: string; input?: unknown }
  | { id: number; type: "unsubscribe" };

type ServerMsg =
  | { id: number; type: "result"; result: unknown }
  | {
      id: number;
      type: "error";
      error: { code?: string; message?: string; details?: unknown };
    }
  | { id: number; type: "next"; value: unknown }
  | { id: number; type: "complete" };

// Unexpected errors are masked (see `publicError`) and logged.
function toErr(e: unknown): { code: string; message: string; details?: unknown } {
  if (!(e instanceof DendraError)) console.error("[dendra] ws: unexpected error:", e);
  return publicError(e);
}

// --------------------------------------------------------------------------
// Server session — one per connection.
// --------------------------------------------------------------------------
export interface WsSession {
  handleMessage(raw: string): void;
  handleClose(): void;
}

/**
 * Low-level: for runtimes without the `ws` package (Bun, Deno, Workers) or an
 * in-memory loopback. No Origin check, size limits, heartbeats or reconnect —
 * on Node use `attachWsServer`, in the browser `createWsConnection`.
 */
export function createWsSession(
  router: object,
  send: (data: string) => void,
  ctx: Record<string, unknown> = {},
  opts: { maxSubscriptions?: number } = {},
): WsSession {
  const root = router as RouterRecord;
  const maxSubscriptions = opts.maxSubscriptions ?? Infinity;
  const subs = new Map<number, AbortController>();
  const out = (m: ServerMsg) => send(JSON.stringify(m));

  return {
    handleMessage(raw) {
      let msg: ClientMsg;
      try {
        msg = JSON.parse(raw) as ClientMsg;
      } catch {
        return;
      }

      if (msg.type === "call") {
        const proc = resolveProc(root, msg.path.split("."));
        if (!proc || proc.kind !== "unary") {
          out({
            id: msg.id,
            type: "error",
            error: { code: "NOT_FOUND", message: `Procedure '${msg.path}' not found` },
          });
          return;
        }
        invokeUnary(proc, msg.input, ctx, { path: msg.path, transport: "ws" }).then(
          (result) => out({ id: msg.id, type: "result", result }),
          (e) => out({ id: msg.id, type: "error", error: toErr(e) }),
        );
        return;
      }

      if (msg.type === "subscribe") {
        const proc = resolveProc(root, msg.path.split("."));
        if (!proc || proc.kind !== "stream") {
          out({
            id: msg.id,
            type: "error",
            error: { code: "NOT_FOUND", message: `Subscription '${msg.path}' not found` },
          });
          return;
        }
        if (subs.size >= maxSubscriptions) {
          out({
            id: msg.id,
            type: "error",
            error: { code: "TOO_MANY_REQUESTS", message: "Too many subscriptions on this connection" },
          });
          return;
        }
        const ac = new AbortController();
        subs.set(msg.id, ac);
        // `ctx.signal` predates the handler's own `signal`; both abort together.
        const subCtx = { ...ctx, signal: ac.signal };
        void (async () => {
          try {
            for await (const value of invokeStream(proc, msg.input, subCtx, {
              path: msg.path,
              transport: "ws",
              signal: ac.signal,
            })) {
              if (ac.signal.aborted) break;
              out({ id: msg.id, type: "next", value: value ?? null }); // as over HTTP
            }
            if (!ac.signal.aborted) out({ id: msg.id, type: "complete" });
          } catch (e) {
            out({ id: msg.id, type: "error", error: toErr(e) });
          } finally {
            subs.delete(msg.id);
          }
        })();
        return;
      }

      if (msg.type === "unsubscribe") {
        subs.get(msg.id)?.abort();
        subs.delete(msg.id);
      }
    },

    handleClose() {
      for (const ac of subs.values()) ac.abort();
      subs.clear();
    },
  };
}

// --------------------------------------------------------------------------
// Client session — typed, multiplexes calls + subscriptions over one socket.
// --------------------------------------------------------------------------
export interface WsClient<R> {
  api: Client<R>;
  receive(raw: string): void;
  /** Ends open subscriptions and rejects pending calls; with `err`, both fail with it instead. */
  close(err?: unknown): void;
}

interface AsyncQueue {
  push(v: unknown): void;
  end(): void;
  error(e: unknown): void;
  iterate(): AsyncIterable<unknown>;
}

function createQueue(): AsyncQueue {
  const values: unknown[] = [];
  let done = false;
  let failure: unknown = null;
  let wake: (() => void) | null = null;
  const signal = () => {
    wake?.();
    wake = null;
  };
  return {
    push(v) {
      values.push(v);
      signal();
    },
    end() {
      done = true;
      signal();
    },
    error(e) {
      failure = e;
      done = true;
      signal();
    },
    async *iterate() {
      for (;;) {
        if (values.length) {
          yield values.shift();
          continue;
        }
        if (failure) throw failure;
        if (done) return;
        await new Promise<void>((r) => {
          wake = r;
        });
      }
    },
  };
}

function noop(): void {}

/**
 * Low-level: for runtimes without the `ws` package (Bun, Deno, Workers) or an
 * in-memory loopback. No Origin check, size limits, heartbeats or reconnect —
 * on Node use `attachWsServer`, in the browser `createWsConnection`.
 */
export function createWsClient<R extends object>(
  send: (data: string) => void,
): WsClient<R> {
  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: unknown) => void }
  >();
  const streams = new Map<number, AsyncQueue>();
  const outbound = (m: ClientMsg) => send(JSON.stringify(m));

  const lazyWsCall = (path: string, input: unknown) => ({
    then<T1 = unknown, T2 = never>(
      onF?: ((v: unknown) => T1 | PromiseLike<T1>) | null,
      onR?: ((e: unknown) => T2 | PromiseLike<T2>) | null,
    ): Promise<T1 | T2> {
      const id = nextId++;
      const p = new Promise<unknown>((resolve, reject) =>
        pending.set(id, { resolve, reject }),
      );
      outbound({ id, type: "call", path, input });
      return p.then(onF, onR);
    },
    async *[Symbol.asyncIterator]() {
      const id = nextId++;
      const q = createQueue();
      streams.set(id, q);
      outbound({ id, type: "subscribe", path, input });
      try {
        yield* q.iterate();
      } finally {
        outbound({ id, type: "unsubscribe" });
        streams.delete(id);
      }
    },
  });

  const build = (path: string[]): unknown =>
    new Proxy(noop, {
      get(_t, key) {
        if (typeof key !== "string" || key === "then") return undefined;
        return build([...path, key]);
      },
      apply(_t, _this, args: unknown[]) {
        return lazyWsCall(path.join("."), args[0]);
      },
    });

  return {
    api: build([]) as Client<R>,
    receive(raw) {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(raw) as ServerMsg;
      } catch {
        return;
      }
      if (msg.type === "result") {
        pending.get(msg.id)?.resolve(msg.result);
        pending.delete(msg.id);
      } else if (msg.type === "error") {
        const err = new DendraClientError(msg.error);
        if (pending.has(msg.id)) {
          pending.get(msg.id)!.reject(err);
          pending.delete(msg.id);
        } else if (streams.has(msg.id)) {
          streams.get(msg.id)!.error(err);
          streams.delete(msg.id);
        }
      } else if (msg.type === "next") {
        streams.get(msg.id)?.push(msg.value);
      } else if (msg.type === "complete") {
        streams.get(msg.id)?.end();
        streams.delete(msg.id);
      }
    },
    close(err) {
      for (const q of streams.values()) err ? q.error(err) : q.end();
      streams.clear();
      for (const p of pending.values()) {
        p.reject(err ?? new DendraClientError({ code: "INTERNAL", message: "connection closed" }));
      }
      pending.clear();
    },
  };
}

// --------------------------------------------------------------------------
// Thin bindings to real sockets.
// --------------------------------------------------------------------------

/** Bind the server session to a `ws`-style socket (ws package, Bun). */
export interface WsLikeSocket {
  send(data: string): void;
  on(event: "message", cb: (data: unknown) => void): void;
  on(event: "close", cb: () => void): void;
}
/**
 * Low-level: for runtimes without the `ws` package (Bun, Deno, Workers) or an
 * in-memory loopback. No Origin check, size limits, heartbeats or reconnect —
 * on Node use `attachWsServer`, in the browser `createWsConnection`.
 */
export function attachWs(
  socket: WsLikeSocket,
  router: object,
  ctx: Record<string, unknown> = {},
): void {
  const session = createWsSession(router, (d) => socket.send(d), ctx);
  socket.on("message", (d) =>
    session.handleMessage(typeof d === "string" ? d : String(d)),
  );
  socket.on("close", () => session.handleClose());
}

/** Bind the typed client to a WHATWG WebSocket (browser, Node global WebSocket). */
export interface WhatwgSocket {
  send(data: string): void;
  addEventListener(event: "message", cb: (e: { data: unknown }) => void): void;
  addEventListener(event: "close", cb: () => void): void;
}
/**
 * Low-level: for runtimes without the `ws` package (Bun, Deno, Workers) or an
 * in-memory loopback. No Origin check, size limits, heartbeats or reconnect —
 * on Node use `attachWsServer`, in the browser `createWsConnection`.
 */
export function connectWs<R extends object>(
  socket: WhatwgSocket,
): Client<R> {
  const client = createWsClient<R>((d) => socket.send(d));
  socket.addEventListener("message", (e) =>
    client.receive(typeof e.data === "string" ? e.data : String(e.data)),
  );
  socket.addEventListener("close", () => client.close());
  return client.api;
}
