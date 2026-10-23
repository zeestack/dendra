// A browser WebSocket connection that stays up. `connectWs` binds the typed client
// to one socket; when that socket drops, its calls fail and its subscriptions end.
// Real apps then rebuild the same loop: reconnect with backoff, retry at once when
// the network comes back, show "reconnecting", stop when the server says "signed
// out", and resubscribe. This is that loop, once.
//
//   const conn = createWsConnection<AppRouter>(`wss://${location.host}/ws`);
//   conn.onStatus((s) => setBanner(s));          // connecting | connected | reconnecting | stopped | closed
//   for await (const ev of conn.api.notes.watch()) render(ev); // survives reconnects
//
// Subscriptions resubscribe after a reconnect; anything published while the socket
// was down is missed, so treat "connected" as the cue to refetch. Calls made while
// disconnected fail at once with code "UNAVAILABLE" rather than being replayed
// later, when the data they were based on may have changed.

import type { Client } from "./caller.ts";
import { DendraClientError } from "./errors.ts";
import { createWsClient, type WsClient } from "./ws.ts";

export type WsStatus = "connecting" | "connected" | "reconnecting" | "stopped" | "closed";

/** The socket `createWsConnection` drives (a browser or Node `WebSocket` matches). */
export interface WsBrowserSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(event: "message", cb: (e: { data: unknown }) => void): void;
  addEventListener(event: "close", cb: (e: { code?: number; reason?: string }) => void): void;
  addEventListener(event: "open" | "error", cb: () => void): void;
}

export interface WsConnectionOptions {
  /** Reconnect delay: starts at `initialMs`, doubles up to `maxMs`, ±25% jitter. Default 500 ms → 10 s. */
  backoff?: { initialMs?: number; maxMs?: number };
  /** Close codes that stop reconnecting (status "stopped") until `reconnect()`. Default `[4401]`. */
  stopOn?: number[];
  /** Where to hear "online" to retry at once. Default `globalThis` in browsers; `false` turns it off. */
  online?: Pick<EventTarget, "addEventListener" | "removeEventListener"> | false;
}

export interface WsConnection<R> {
  api: Client<R>;
  readonly status: WsStatus;
  /** Called on every status change; returns an unsubscribe. */
  onStatus(cb: (status: WsStatus, info?: { code?: number; reason?: string }) => void): () => void;
  /** Reconnect now: after "stopped" (e.g. signed back in), or to skip a backoff wait. */
  reconnect(): void;
  /** Close for good: subscriptions end, pending calls fail, no more reconnects. */
  close(): void;
}

const OPEN = 1;
const unavailable = (message: string) => new DendraClientError({ code: "UNAVAILABLE", message });

function noop(): void {}

export function createWsConnection<R extends object>(
  open: string | (() => WsBrowserSocket),
  opts: WsConnectionOptions = {},
): WsConnection<R> {
  const make =
    typeof open === "string"
      ? () => new (globalThis as unknown as { WebSocket: new (url: string) => WsBrowserSocket }).WebSocket(open)
      : open;
  const initialMs = opts.backoff?.initialMs ?? 500;
  const maxMs = opts.backoff?.maxMs ?? 10_000;
  const stopOn = opts.stopOn ?? [4401];
  const g = globalThis as { addEventListener?: unknown };
  const online =
    opts.online === false
      ? undefined
      : (opts.online ?? (typeof g.addEventListener === "function" ? (globalThis as unknown as EventTarget) : undefined));

  let status: WsStatus = "connecting";
  // A function, so TypeScript doesn't narrow `status` across the awaits where it changes.
  const isClosed = () => status === "closed";
  const listeners = new Set<(s: WsStatus, info?: { code?: number; reason?: string }) => void>();
  // Subscription loops wait here for the next status change.
  let changed: () => void = noop;
  let nextChange = new Promise<void>((r) => (changed = r));
  const setStatus = (s: WsStatus, info?: { code?: number; reason?: string }) => {
    if (s === status) return;
    status = s;
    for (const l of listeners) l(s, info);
    const wake = changed;
    nextChange = new Promise<void>((r) => (changed = r));
    wake();
  };

  /** Set only while open: which client to use, and the error that marks its loss. */
  let current: { client: WsClient<R>; lost: DendraClientError } | null = null;
  let socket: WsBrowserSocket | null = null;
  let attempt = 0;
  let retry: ReturnType<typeof setTimeout> | undefined;

  function connect(): void {
    retry = undefined;
    if (status === "closed") return;
    const ws = make();
    socket = ws;
    const client = createWsClient<R>((d) => {
      if (ws.readyState === OPEN) ws.send(d);
    });
    const lost = unavailable("Connection lost");
    ws.addEventListener("error", noop); // the close event that follows carries what matters
    ws.addEventListener("message", (e) => client.receive(typeof e.data === "string" ? e.data : String(e.data)));
    ws.addEventListener("open", () => {
      if (socket !== ws) return;
      attempt = 0;
      current = { client, lost };
      setStatus("connected");
    });
    ws.addEventListener("close", (e) => {
      if (current?.client === client) current = null;
      client.close(lost);
      if (socket !== ws) return; // replaced by reconnect()/online, or closed by us
      socket = null;
      const info = { code: e?.code, reason: e?.reason };
      if (e?.code !== undefined && stopOn.includes(e.code)) return setStatus("stopped", info);
      setStatus("reconnecting", info);
      const base = Math.min(maxMs, initialMs * 2 ** attempt++);
      retry = setTimeout(connect, base * (0.75 + Math.random() * 0.5));
    });
  }

  // Drop whatever is pending and connect now.
  function restart(): void {
    clearTimeout(retry);
    attempt = 0;
    const old = socket;
    socket = null;
    old?.close();
    connect();
  }

  const onOnline = () => {
    if (status === "reconnecting") restart();
  };
  online?.addEventListener("online", onOnline);
  connect();

  const target = (client: WsClient<R>, path: string): ((input: unknown) => unknown) =>
    path.split(".").reduce((o: any, k) => o[k], client.api);

  function call(path: string, input: unknown) {
    const run = (): Promise<unknown> =>
      current ? Promise.resolve(target(current.client, path)(input)) : Promise.reject(unavailable("Not connected"));
    return {
      then: (onF?: (v: unknown) => unknown, onR?: (e: unknown) => unknown) => run().then(onF, onR),
      catch: (onR: (e: unknown) => unknown) => run().catch(onR),
      finally: (f: () => void) => run().finally(f),
      async *[Symbol.asyncIterator]() {
        for (;;) {
          while (status !== "connected") {
            if (status === "closed") return;
            await nextChange;
          }
          const { client, lost } = current!;
          try {
            yield* target(client, path)(input) as AsyncIterable<unknown>;
            return; // the server completed it
          } catch (e) {
            if (e !== lost) throw e;
            if (isClosed()) return; // close() also fails the stream with `lost`
            // connection lost: resubscribe once it's back
          }
        }
      },
    };
  }

  const build = (path: string[]): unknown =>
    new Proxy(noop, {
      get(_t, key) {
        if (typeof key !== "string" || key === "then") return undefined;
        return build([...path, key]);
      },
      apply(_t, _this, args: unknown[]) {
        return call(path.join("."), args[0]);
      },
    });

  return {
    api: build([]) as Client<R>,
    get status() {
      return status;
    },
    onStatus(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    reconnect() {
      if (status === "closed" || status === "connected") return;
      setStatus("reconnecting");
      restart();
    },
    close() {
      if (status === "closed") return;
      setStatus("closed");
      clearTimeout(retry);
      online?.removeEventListener("online", onOnline);
      const ws = socket;
      socket = null;
      const c = current;
      current = null;
      c?.client.close(c.lost);
      ws?.close(1000, "Closed");
    },
  };
}
