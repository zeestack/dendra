// Serve dendra over WebSocket with safe defaults. `attachWs` runs calls over a
// socket that is already open; this is everything before and around that, which
// every app otherwise rebuilds: accept the upgrade only on one path, check the
// Origin (browsers apply no CORS to WebSockets, so any site can open one with the
// user's cookies), build the context once per connection BEFORE the socket
// opens, and refuse with a plain HTTP status when either fails.
//
//   const wss = new WebSocketServer({ noServer: true, maxPayload: 1_000_000 });
//   const live = attachWsServer(wss, appRouter, {
//     path: "/rpc/ws",
//     allowedOrigins: ["https://app.example.com"],
//     createContext: async (req) => ({ user: await getSession(req.headers) }),
//   });
//   server.on("upgrade", (req, socket, head) => {
//     if (!live.handleUpgrade(req, socket, head)) nextUpgrade(req, socket, head);
//   });
//
// Kept ZERO-DEPENDENCY: `ws`, `node:http` and `node:stream` are matched by the
// structural types below, never imported.

import { DendraError } from "./errors.ts";
import { createWsSession, type WsLikeSocket } from "./ws.ts";

/** The upgrade request (an `http.IncomingMessage` matches). */
export interface WsUpgradeRequest {
  url?: string;
  headers: Record<string, string | string[] | undefined>;
}

/** The raw socket of an upgrade (a `stream.Duplex` matches). */
export interface WsUpgradeSocket {
  write(data: string): unknown;
  destroy(): void;
  destroyed?: boolean;
  on(event: "error", cb: (err: Error) => void): unknown;
  off(event: "error", cb: (err: Error) => void): unknown;
}

/** An accepted socket (a `ws` `WebSocket` matches). */
export interface WsServerSocket extends WsLikeSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  ping(): void;
  terminate(): void;
  close(code?: number, reason?: string): void;
  on(event: "message", cb: (data: unknown) => void): void;
  on(event: "close", cb: (code: number, reason: unknown) => void): void;
  on(event: "pong", cb: () => void): void;
  on(event: "error", cb: (err: Error) => void): void;
}

/** What `attachWsServer` needs from a WebSocket server (a `ws` `WebSocketServer` with `noServer: true` matches). */
export interface WsServerLike {
  handleUpgrade(req: any, socket: any, head: any, cb: (ws: WsServerSocket) => void): void;
  options?: { maxPayload?: number };
}

export interface WsServerOptions<Ctx> {
  /** Exact pathname to accept (query string ignored). Other paths are left alone. */
  path: string;
  /** Exact origins (`scheme://host[:port]`), or a predicate. Required: there is no "allow all" default. */
  allowedOrigins: string[] | ((origin: string) => boolean);
  /** Accept upgrades with no `Origin` (non-browser clients). Only safe when auth isn't cookie-based. Default false. */
  allowMissingOrigin?: boolean;
  /** Once per connection, before the socket opens. A thrown `DendraError` refuses with its status. */
  createContext?: (req: Request) => Ctx | Promise<Ctx>;
  /** Largest message in bytes. Default 1 MB. */
  maxPayload?: number;
  /** Ping interval; a socket that misses one pong is terminated. `0` disables. Default 30 s. */
  heartbeatMs?: number;
  /** Unsent bytes allowed per socket before it is closed with 1013. Default 1 MB. */
  maxBufferedBytes?: number;
  /** Open subscriptions per connection. Default 100. */
  maxSubscriptions?: number;
  /** Re-check long-lived connections; `false` closes with 4401, a throw keeps the connection. */
  revalidate?: { everyMs: number; check: (ctx: Ctx) => boolean | Promise<boolean> };
  /** How long `close()` / `closeWhere()` wait for the close handshake. Default 1 s. */
  closeGraceMs?: number;
  /** Once per accepted connection, whatever closed it. */
  onClose?: (ctx: Ctx, info: { code: number; reason: string }) => void | Promise<void>;
  /** Unexpected `createContext` errors, revalidate and `onClose` errors, socket errors. Default `console.error`. */
  onError?: (err: unknown) => void;
}

export interface WsServerHandle<Ctx> {
  /** `true` if the upgrade is for our path (it then accepts or refuses it); `false` leaves it untouched. */
  handleUpgrade(req: WsUpgradeRequest, socket: WsUpgradeSocket, head: unknown): boolean;
  /** Close matching connections (default 4401 "Unauthorized"); returns how many. */
  closeWhere(match: (ctx: Ctx) => boolean, close?: { code?: number; reason?: string }): number;
  /** Refuse new upgrades, close open sockets with 1001, resolve once all have closed. */
  close(): Promise<void>;
  /** Open connections. */
  readonly size: number;
}

const REASONS: Record<number, string> = {
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  500: "Internal Server Error",
  503: "Service Unavailable",
};

const OPEN = 1;

function refuse(socket: WsUpgradeSocket, status: number): void {
  if (socket.destroyed) return;
  socket.write(
    `HTTP/1.1 ${status} ${REASONS[status] ?? status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
  socket.destroy();
}

function toRequest(req: WsUpgradeRequest): Request {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) for (const x of v) headers.append(k, x);
    else if (v !== undefined) headers.set(k, v);
  }
  const host = headers.get("host") ?? "localhost";
  return new Request(`http://${host}${req.url ?? "/"}`, { method: "GET", headers });
}

export function attachWsServer<Ctx extends Record<string, unknown>>(
  wss: WsServerLike,
  router: object,
  opts: WsServerOptions<Ctx>,
): WsServerHandle<Ctx> {
  const allowed = opts.allowedOrigins;
  const originOk = typeof allowed === "function" ? allowed : (o: string) => allowed.includes(o);
  const onError = opts.onError ?? ((e: unknown) => console.error("[dendra] ws:", e));
  const maxSubscriptions = opts.maxSubscriptions ?? 100;
  const maxPayload = opts.maxPayload ?? 1_000_000;
  const maxBufferedBytes = opts.maxBufferedBytes ?? 1_000_000;
  const heartbeatMs = opts.heartbeatMs ?? 30_000;
  const closeGraceMs = opts.closeGraceMs ?? 1_000;

  // `ws` buffers a whole message before we see it, up to its own limit (100 MiB
  // by default), so a larger limit there defeats ours. Fail at startup.
  const serverMax = wss.options?.maxPayload;
  if (serverMax !== undefined && serverMax > maxPayload) {
    throw new Error(
      `[dendra] ws: the ws server accepts messages up to ${serverMax} bytes; pass { maxPayload: ${maxPayload} } to new WebSocketServer(...)`,
    );
  }
  // Without `options` we can't tell what the server enforces, so check ourselves.
  const checkSize = !wss.options;
  const encoder = new TextEncoder();
  const byteLength = (data: unknown) =>
    typeof data === "string" ? encoder.encode(data).length : ((data as { byteLength?: number }).byteLength ?? 0);

  type Conn = { ctx: Ctx; alive: boolean; checking: boolean; settled: Promise<void> };
  const live = new Map<WsServerSocket, Conn>();
  let closing = false;
  let closed: Promise<void> | undefined;

  // Close politely, then force it: a client that never answers the close
  // handshake must not hold a connection (or a shutdown) open.
  function closeSocket(ws: WsServerSocket, code: number, reason: string): void {
    ws.close(code, reason);
    const t = setTimeout(() => ws.terminate(), closeGraceMs);
    (t as { unref?: () => void }).unref?.();
    live.get(ws)?.settled.finally(() => clearTimeout(t));
  }

  const heartbeat =
    heartbeatMs > 0
      ? setInterval(() => {
          for (const [ws, c] of live) {
            if (!c.alive) {
              ws.terminate();
              continue;
            }
            c.alive = false;
            ws.ping();
          }
        }, heartbeatMs)
      : undefined;
  (heartbeat as { unref?: () => void } | undefined)?.unref?.();

  // Only `false` closes: a throw is the auth backend blipping, not a revoked session.
  const reval = opts.revalidate;
  const recheck = reval
    ? setInterval(() => {
        for (const [ws, c] of live) {
          if (c.checking) continue;
          c.checking = true;
          Promise.resolve()
            .then(() => reval.check(c.ctx))
            .then(
              (ok) => {
                if (ok === false && live.has(ws)) closeSocket(ws, 4401, "Unauthorized");
              },
              onError,
            )
            .finally(() => {
              c.checking = false;
            });
        }
      }, reval.everyMs)
    : undefined;
  (recheck as { unref?: () => void } | undefined)?.unref?.();

  function accept(ws: WsServerSocket, ctx: Ctx): void {
    let settle!: () => void;
    const conn: Conn = { ctx, alive: true, checking: false, settled: new Promise((r) => (settle = r)) };
    live.set(ws, conn);
    ws.on("error", (e) => onError(e));
    ws.on("pong", () => {
      conn.alive = true;
    });
    const send = (d: string) => {
      if (ws.readyState !== OPEN) return; // a call that settled after the socket closed
      if (ws.bufferedAmount > maxBufferedBytes) return ws.close(1013, "Try Again Later");
      ws.send(d);
    };
    const session = createWsSession(router, send, ctx, { maxSubscriptions });
    ws.on("message", (data) => {
      if (checkSize && byteLength(data) > maxPayload) return ws.close(1009, "Message Too Big");
      session.handleMessage(String(data));
    });
    ws.on("close", (code, reason) => {
      if (!live.delete(ws)) return;
      session.handleClose();
      Promise.resolve()
        .then(() => opts.onClose?.(ctx, { code, reason: String(reason ?? "") }))
        .catch(onError)
        .finally(settle);
    });
  }

  async function upgrade(req: WsUpgradeRequest, socket: WsUpgradeSocket, head: unknown): Promise<void> {
    // An unhandled socket error during the handshake would crash Node.
    const onSocketError = (e: Error) => onError(e);
    socket.on("error", onSocketError);
    try {
      if (closing) return refuse(socket, 503);

      const origin = req.headers.origin;
      const o = Array.isArray(origin) ? origin[0] : origin;
      if (o === undefined ? !opts.allowMissingOrigin : !originOk(o)) return refuse(socket, 403);

      let ctx: Ctx;
      try {
        ctx = ((await opts.createContext?.(toRequest(req))) ?? {}) as Ctx;
      } catch (e) {
        if (e instanceof DendraError) return refuse(socket, e.status);
        onError(e);
        return refuse(socket, 500);
      }

      if (closing) return refuse(socket, 503);
      if (socket.destroyed) return; // the client gave up while we were checking
      wss.handleUpgrade(req, socket, head, (ws) => accept(ws, ctx));
    } finally {
      socket.off("error", onSocketError);
    }
  }

  return {
    handleUpgrade(req, socket, head) {
      if (new URL(req.url ?? "/", "http://localhost").pathname !== opts.path) return false;
      void upgrade(req, socket, head);
      return true;
    },
    closeWhere(match, close = {}) {
      let n = 0;
      for (const [ws, c] of live) {
        if (!match(c.ctx)) continue;
        closeSocket(ws, close.code ?? 4401, close.reason ?? "Unauthorized");
        n++;
      }
      return n;
    },
    close() {
      closed ??= (async () => {
        closing = true;
        clearInterval(heartbeat);
        clearInterval(recheck);
        const open = [...live];
        for (const [ws] of open) closeSocket(ws, 1001, "Going Away");
        await Promise.all(open.map(([, c]) => c.settled));
      })();
      return closed;
    },
    get size() {
      return live.size;
    },
  };
}
