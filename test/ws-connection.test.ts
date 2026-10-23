import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import {
  attachWsServer,
  createInMemoryPubSub,
  createWsConnection,
  DendraClientError,
  initDendra,
  type RouterRecord,
  type WsBrowserSocket,
  type WsStatus,
} from "../src/index.ts";

const pubsub = createInMemoryPubSub();
let aborted = 0;
const { route } = initDendra<{ user?: string | null }>();
const router = {
  echo: route.handler(({ ctx }) => ctx.user ?? "anon"),
  hang: route.handler(() => new Promise<never>(() => {})),
  feed: route.stream(async function* ({ signal }) {
    signal.addEventListener("abort", () => aborted++);
    for await (const m of pubsub.subscribe("feed", { signal })) yield m as number;
  }),
} satisfies RouterRecord;
type R = typeof router;

const ORIGIN = "https://app.test";
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await tick(5);
  expect(check()).toBe(true);
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

// A real attachWsServer that a test can take down and bring back.
async function server() {
  let contexts = 0;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1_000_000 });
  const live = attachWsServer(wss, router, {
    path: "/ws",
    allowedOrigins: [ORIGIN],
    createContext: () => {
      contexts++;
      return { user: "ada" };
    },
  });
  const srv = http.createServer();
  srv.on("upgrade", (req, socket, head) => live.handleUpgrade(req, socket, head));
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as AddressInfo).port;
  let down = false;
  const stop = async () => {
    if (down) return;
    down = true;
    await live.close();
    srv.closeAllConnections();
    await new Promise<void>((r) => srv.close(() => r()));
  };
  cleanups.push(stop);
  const open = () => new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { origin: ORIGIN } }) as unknown as WsBrowserSocket;
  return { live, open, stop, contexts: () => contexts };
}

function track(conn: { onStatus(cb: (s: WsStatus) => void): () => void }) {
  const seen: WsStatus[] = [];
  conn.onStatus((s) => seen.push(s));
  return seen;
}

describe("createWsConnection", () => {
  it("connects and runs calls", async () => {
    const { open } = await server();
    const conn = createWsConnection<R>(open);
    cleanups.push(() => conn.close());
    await until(() => conn.status === "connected");
    expect(await conn.api.echo()).toBe("ada");
  });

  it("reconnects after the server drops the socket", async () => {
    const { open, live } = await server();
    const conn = createWsConnection<R>(open, { backoff: { initialMs: 10 } });
    cleanups.push(() => conn.close());
    const seen = track(conn);
    await until(() => conn.status === "connected");
    live.closeWhere(() => true, { code: 4000, reason: "drop" });
    await until(() => seen.includes("reconnecting") && conn.status === "connected");
    expect(await conn.api.echo()).toBe("ada");
  });

  it("resumes a subscription after reconnecting", async () => {
    const { open, live } = await server();
    const conn = createWsConnection<R>(open, { backoff: { initialMs: 10 } });
    cleanups.push(() => conn.close());
    await until(() => conn.status === "connected");
    const got: number[] = [];
    const done = (async () => {
      for await (const n of conn.api.feed()) {
        got.push(n);
        if (n === 2) break;
      }
    })();
    await tick(30);
    pubsub.publish("feed", 1);
    await until(() => got.length === 1);
    live.closeWhere(() => true, { code: 4000, reason: "drop" });
    await until(() => conn.status === "reconnecting");
    await until(() => conn.status === "connected");
    await tick(30); // the resubscribe reaches the server
    pubsub.publish("feed", 2);
    await done;
    expect(got).toEqual([1, 2]);
  });

  it("stops on 4401 and resumes with reconnect()", async () => {
    const { open, live, contexts } = await server();
    const conn = createWsConnection<R>(open, { backoff: { initialMs: 10 } });
    cleanups.push(() => conn.close());
    await until(() => conn.status === "connected");
    live.closeWhere(() => true); // default 4401 "Unauthorized"
    await until(() => conn.status === "stopped");
    const before = contexts();
    await tick(100);
    expect(contexts()).toBe(before);
    conn.reconnect();
    await until(() => conn.status === "connected");
  });

  it("fails a call made while disconnected with UNAVAILABLE", async () => {
    const { open, stop } = await server();
    const conn = createWsConnection<R>(open, { backoff: { initialMs: 10_000 } });
    cleanups.push(() => conn.close());
    await until(() => conn.status === "connected");
    await stop();
    await until(() => conn.status === "reconnecting");
    await expect(conn.api.echo()).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });

  it("fails an in-flight call with UNAVAILABLE when the connection drops", async () => {
    const { open, live } = await server();
    const conn = createWsConnection<R>(open, { backoff: { initialMs: 10 } });
    cleanups.push(() => conn.close());
    await until(() => conn.status === "connected");
    const pending = conn.api.hang();
    await tick(20);
    live.closeWhere(() => true, { code: 4000, reason: "drop" });
    const err = await pending.then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(DendraClientError);
    expect(err).toMatchObject({ code: "UNAVAILABLE" });
  });

  it("retries at once when the browser comes back online", async () => {
    const online = new EventTarget();
    let attempts = 0;
    const { open: real } = await server();
    let up = false;
    const open = () => {
      attempts++;
      return up ? real() : (new WebSocket("ws://127.0.0.1:1/nope") as unknown as WsBrowserSocket);
    };
    const conn = createWsConnection<R>(open, { backoff: { initialMs: 60_000 }, online });
    cleanups.push(() => conn.close());
    await until(() => attempts === 1 && conn.status !== "connecting");
    up = true;
    online.dispatchEvent(new Event("online"));
    await until(() => conn.status === "connected", 1000);
    expect(attempts).toBe(2);
  });

  it("close() ends subscriptions and stops reconnecting", async () => {
    const { open, contexts } = await server();
    const conn = createWsConnection<R>(open, { backoff: { initialMs: 10 } });
    await until(() => conn.status === "connected");
    const done = (async () => {
      for await (const _ of conn.api.feed()) void _;
      return "ended";
    })();
    await tick(30);
    conn.close();
    expect(await done).toBe("ended");
    expect(conn.status).toBe("closed");
    const before = contexts();
    await tick(100);
    expect(contexts()).toBe(before);
  });

  it("unsubscribes on the server when the consumer breaks out", async () => {
    const { open } = await server();
    const conn = createWsConnection<R>(open);
    cleanups.push(() => conn.close());
    await until(() => conn.status === "connected");
    const before = aborted;
    const done = (async () => {
      for await (const _ of conn.api.feed()) break;
    })();
    await tick(30);
    pubsub.publish("feed", 1);
    await done;
    await until(() => aborted === before + 1);
  });

  it("backs off 0.5 s doubling to 10 s, with jitter", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5); // jitter factor exactly 1
    try {
      const times: number[] = [];
      const t0 = Date.now();
      // A socket that fails to connect: emits close right away, so the gaps are pure backoff.
      const open = (): WsBrowserSocket => {
        times.push(Date.now() - t0);
        const t = new EventTarget();
        queueMicrotask(() => t.dispatchEvent(Object.assign(new Event("close"), { code: 1006, reason: "" })));
        return Object.assign(t, { send() {}, close() {}, readyState: 0 }) as unknown as WsBrowserSocket;
      };
      const conn = createWsConnection<R>(open, { online: false });
      await vi.advanceTimersByTimeAsync(60_000);
      conn.close();
      const gaps = times.slice(1).map((t, i) => t - times[i]);
      expect(gaps.slice(0, 7)).toEqual([500, 1000, 2000, 4000, 8000, 10_000, 10_000]);
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });
});
