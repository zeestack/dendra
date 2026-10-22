import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import {
  attachWsServer,
  connectWs,
  DendraError,
  initDendra,
  type RouterRecord,
  type WsServerHandle,
  type WsServerLike,
  type WsServerOptions,
  type WsServerSocket,
} from "../src/index.ts";

type Ctx = { user?: string | null };
const { route } = initDendra<Ctx>();
let releaseSlow: () => void = () => {};
const router = {
  whoami: route.handler(({ ctx }) => ctx.user ?? null),
  slow: route.handler(() => new Promise<string>((r) => (releaseSlow = () => r("late")))),
  flood: route.stream(async function* () {
    for (let i = 0; i < 50; i++) yield "x".repeat(100_000);
  }),
  ticks: route.stream(async function* ({ signal }) {
    yield "on";
    await new Promise<void>((r) => signal.addEventListener("abort", () => r()));
  }),
} satisfies RouterRecord;

const ORIGIN = "https://app.test";
const PATH = "/rpc/ws";
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

// A real http server + ws server in noServer mode, as an app would wire them.
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function start(
  opts: Partial<WsServerOptions<Ctx>> = {},
  wss: WsServerLike = new WebSocketServer({ noServer: true, maxPayload: 1_000_000 }),
) {
  const handle: WsServerHandle<Ctx> = attachWsServer<Ctx>(wss, router, {
    path: PATH,
    allowedOrigins: [ORIGIN],
    ...opts,
  });
  const server = http.createServer();
  const upgrades: boolean[] = [];
  server.on("upgrade", (req, socket, head) => {
    const ours = handle.handleUpgrade(req, socket, head);
    upgrades.push(ours);
    if (!ours) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      socket.destroy();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const clients: WebSocket[] = [];
  cleanups.push(async () => {
    for (const c of clients) c.terminate();
    await handle.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });

  /** Resolves `{ ws }` once open, or `{ status }` if the upgrade is refused. */
  function connect(
    path = PATH,
    headers: Record<string, string> = { origin: ORIGIN },
    clientOpts: WebSocket.ClientOptions = {},
  ): Promise<{ ws?: WebSocket; status?: number }> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers, ...clientOpts });
    clients.push(ws);
    return new Promise((resolve, reject) => {
      ws.once("open", () => resolve({ ws }));
      ws.once("unexpected-response", (_req, res) => resolve({ status: res.statusCode }));
      ws.once("error", (e) => {
        if (!ws.listenerCount("unexpected-response")) reject(e);
      });
    });
  }

  return { handle, connect, upgrades, port, clients };
}

const closed = (ws: WebSocket) =>
  new Promise<{ code: number; reason: string }>((r) =>
    ws.once("close", (code, reason) => r({ code, reason: reason.toString() })),
  );

describe("attachWsServer: upgrade gate", () => {
  it("accepts an allowed origin and gives procedures the connection's context", async () => {
    const { connect } = await start({ createContext: (req) => ({ user: req.headers.get("x-user") }) });
    const { ws } = await connect(PATH, { origin: ORIGIN, "x-user": "ada" });
    const api = connectWs<typeof router>(ws as never);
    expect(await api.whoami()).toBe("ada");
  });

  it("returns false for other paths and leaves the socket alone", async () => {
    const { connect, upgrades } = await start();
    expect(await connect("/other")).toEqual({ status: 404 });
    expect(upgrades).toEqual([false]);
  });

  it("matches the path with a query string but not with a trailing slash", async () => {
    const { connect } = await start();
    expect((await connect(`${PATH}?v=2`)).ws).toBeDefined();
    expect(await connect(`${PATH}/`)).toEqual({ status: 404 });
  });

  it("refuses a missing, unlisted or null Origin with 403", async () => {
    const createContext = vi.fn(() => ({}));
    const { connect } = await start({ createContext });
    expect(await connect(PATH, {})).toEqual({ status: 403 });
    expect(await connect(PATH, { origin: "https://evil.test" })).toEqual({ status: 403 });
    expect(await connect(PATH, { origin: "null" })).toEqual({ status: 403 });
    expect(createContext).not.toHaveBeenCalled();
  });

  it("accepts a missing Origin only with allowMissingOrigin", async () => {
    const { connect } = await start({ allowMissingOrigin: true });
    expect((await connect(PATH, {})).ws).toBeDefined();
    expect(await connect(PATH, { origin: "https://evil.test" })).toEqual({ status: 403 });
  });

  it("accepts origins by function", async () => {
    const { connect } = await start({ allowedOrigins: (o) => o.endsWith(".app.test") });
    expect((await connect(PATH, { origin: "https://eu.app.test" })).ws).toBeDefined();
    expect(await connect(PATH, { origin: ORIGIN })).toEqual({ status: 403 });
  });

  it("refuses with the DendraError's status", async () => {
    const { connect } = await start({
      createContext: (req) => {
        throw new DendraError(req.headers.get("x-as") === "member" ? "FORBIDDEN" : "UNAUTHORIZED", "no");
      },
    });
    expect(await connect(PATH, { origin: ORIGIN })).toEqual({ status: 401 });
    expect(await connect(PATH, { origin: ORIGIN, "x-as": "member" })).toEqual({ status: 403 });
  });

  it("refuses an unexpected createContext error with 500 and reports it", async () => {
    const boom = new Error("db down");
    const onError = vi.fn();
    const { connect } = await start({
      createContext: () => {
        throw boom;
      },
      onError,
    });
    expect(await connect()).toEqual({ status: 500 });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(boom);
  });

  it("builds a GET Request with the upgrade's URL and headers", async () => {
    let seen: Request | undefined;
    const { connect } = await start({
      createContext: (req) => {
        seen = req;
        return {};
      },
    });
    await connect(`${PATH}?v=2`, { origin: ORIGIN, "x-tag": "a" });
    expect(seen!.method).toBe("GET");
    const url = new URL(seen!.url);
    expect(url.pathname).toBe(PATH);
    expect(url.searchParams.get("v")).toBe("2");
    expect(seen!.headers.get("x-tag")).toBe("a");
    expect(seen!.headers.get("origin")).toBe(ORIGIN);
  });

  it("does not open or count a socket whose client left during createContext", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const onClose = vi.fn();
    const onError = vi.fn();
    const { handle, port } = await start({
      createContext: async () => {
        await gate;
        return {};
      },
      onClose,
      onError,
    });
    const ws = new WebSocket(`ws://127.0.0.1:${port}${PATH}`, { headers: { origin: ORIGIN } });
    ws.on("error", () => {});
    await tick(20);
    ws.terminate();
    await tick(20);
    release();
    await tick(20);
    expect(handle.size).toBe(0);
    expect(onClose).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });
});


// Wraps a real ws server so a test can reach each accepted server-side socket.
function capturing(wss: WebSocketServer, keepOptions = true) {
  const sockets: WsServerSocket[] = [];
  const like: WsServerLike = {
    handleUpgrade: (req, socket, head, cb) =>
      wss.handleUpgrade(req, socket, head, (ws) => {
        sockets.push(ws as unknown as WsServerSocket);
        cb(ws as unknown as WsServerSocket);
      }),
    ...(keepOptions ? { options: wss.options } : {}),
  };
  return { like, sockets };
}

describe("attachWsServer: limits and heartbeat", () => {
  it("throws at startup when the ws server allows bigger messages than maxPayload", () => {
    expect(() =>
      attachWsServer(new WebSocketServer({ noServer: true }), router, { path: PATH, allowedOrigins: [ORIGIN] }),
    ).toThrow(/maxPayload/);
    expect(() =>
      attachWsServer(new WebSocketServer({ noServer: true, maxPayload: 1_000_000 }), router, {
        path: PATH,
        allowedOrigins: [ORIGIN],
      }),
    ).not.toThrow();
  });

  it("closes with 1009 on a message over maxPayload", async () => {
    const { connect } = await start({ maxPayload: 1000 }, new WebSocketServer({ noServer: true, maxPayload: 1000 }));
    const { ws } = await connect();
    const done = closed(ws!);
    ws!.send("a".repeat(2000));
    expect((await done).code).toBe(1009);
  });

  it("checks message size itself when the server exposes no options", async () => {
    const { like } = capturing(new WebSocketServer({ noServer: true, maxPayload: 1_000_000 }), false);
    const { connect } = await start({ maxPayload: 1000 }, like);
    const { ws } = await connect();
    const done = closed(ws!);
    ws!.send("é".repeat(1000)); // 1000 characters, 2000 bytes
    expect((await done).code).toBe(1009);
  });

  it("closes with 1013 when the unsent backlog passes maxBufferedBytes", async () => {
    const { connect } = await start({ maxBufferedBytes: 10_000 });
    const { ws } = await connect();
    const done = closed(ws!);
    (ws as unknown as { _socket: { pause(): void; resume(): void } })._socket.pause();
    ws!.send(JSON.stringify({ id: 1, type: "subscribe", path: "flood" }));
    await tick(100);
    (ws as unknown as { _socket: { resume(): void } })._socket.resume();
    expect((await done).code).toBe(1013);
  });

  it("drops a reply whose call finishes after the socket closed", async () => {
    const { like, sockets } = capturing(new WebSocketServer({ noServer: true, maxPayload: 1_000_000 }));
    const onError = vi.fn();
    const { connect } = await start({ onError }, like);
    const { ws } = await connect();
    ws!.send(JSON.stringify({ id: 1, type: "call", path: "slow" }));
    await tick(20);
    const send = vi.spyOn(sockets[0], "send");
    const done = closed(ws!);
    ws!.close();
    await done;
    await tick(20);
    releaseSlow();
    await tick(20);
    expect(send).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("terminates a socket that stops answering pings", async () => {
    const { connect, handle } = await start({ heartbeatMs: 50 });
    const { ws } = await connect(PATH, { origin: ORIGIN }, { autoPong: false });
    const done = closed(ws!);
    await Promise.race([done, tick(400)]);
    expect(ws!.readyState).toBe(WebSocket.CLOSED);
    await tick(20); // the server's own close event lands just after the client's
    expect(handle.size).toBe(0);
  });

  it("keeps a socket that answers pings", async () => {
    const { connect, handle } = await start({ heartbeatMs: 50 });
    const { ws } = await connect();
    await tick(300);
    expect(ws!.readyState).toBe(WebSocket.OPEN);
    expect(handle.size).toBe(1);
  });

  it("reports a socket error after open instead of crashing", async () => {
    const { like, sockets } = capturing(new WebSocketServer({ noServer: true, maxPayload: 1_000_000 }));
    const onError = vi.fn();
    const { connect } = await start({ onError }, like);
    await connect();
    const boom = new Error("ECONNRESET");
    (sockets[0] as unknown as { emit(e: string, err: Error): void }).emit("error", boom);
    expect(onError).toHaveBeenCalledWith(boom);
  });
});

describe("attachWsServer: revalidate, closeWhere, onClose", () => {
  const as = (user: string) => ({ origin: ORIGIN, "x-user": user });
  const userCtx = { createContext: (req: Request) => ({ user: req.headers.get("x-user") }) };

  it("closes with 4401 when revalidate returns false", async () => {
    const { connect } = await start({
      ...userCtx,
      revalidate: { everyMs: 50, check: (ctx) => ctx.user !== "bob" },
    });
    const ada = (await connect(PATH, as("ada"))).ws!;
    const bob = (await connect(PATH, as("bob"))).ws!;
    expect(await closed(bob)).toEqual({ code: 4401, reason: "Unauthorized" });
    expect(ada.readyState).toBe(WebSocket.OPEN);
  });

  it("keeps the connection when revalidate throws, and reports it", async () => {
    const onError = vi.fn();
    const { connect } = await start({
      onError,
      revalidate: {
        everyMs: 50,
        check: () => {
          throw new Error("auth backend down");
        },
      },
    });
    const { ws } = await connect();
    await tick(300);
    expect(ws!.readyState).toBe(WebSocket.OPEN);
    expect(onError).toHaveBeenCalled();
  });

  it("runs one check per connection at a time", async () => {
    const check = vi.fn(() => new Promise<boolean>(() => {}));
    const { connect } = await start({ revalidate: { everyMs: 20, check } });
    await connect();
    await connect();
    await tick(200);
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("closeWhere closes matching connections and returns the count", async () => {
    const { connect, handle } = await start(userCtx);
    const a1 = (await connect(PATH, as("ada"))).ws!;
    const a2 = (await connect(PATH, as("ada"))).ws!;
    const b = (await connect(PATH, as("bob"))).ws!;
    const done = [closed(a1), closed(a2)];
    expect(handle.closeWhere((c) => c.user === "ada")).toBe(2);
    expect(await Promise.all(done)).toEqual([
      { code: 4401, reason: "Unauthorized" },
      { code: 4401, reason: "Unauthorized" },
    ]);
    const moved = closed(b);
    expect(handle.closeWhere((c) => c.user === "bob", { code: 4000, reason: "Moved" })).toBe(1);
    expect(await moved).toEqual({ code: 4000, reason: "Moved" });
  });

  it("runs onClose once per connection with the close code and reason", async () => {
    const onClose = vi.fn();
    const { connect } = await start({ ...userCtx, onClose });
    const { ws } = await connect(PATH, as("ada"));
    ws!.close(4000, "bye");
    await tick(50);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith({ user: "ada" }, { code: 4000, reason: "bye" });
  });

  it("reports an onClose rejection", async () => {
    const onError = vi.fn();
    const boom = new Error("save failed");
    const { connect } = await start({ onError, onClose: async () => Promise.reject(boom) });
    const { ws } = await connect();
    ws!.close();
    await tick(50);
    expect(onError).toHaveBeenCalledWith(boom);
  });

  it("aborts the connection's subscriptions on close", async () => {
    let aborted = false;
    const { route: r } = initDendra<Ctx>();
    const watching = {
      watch: r.stream(async function* ({ signal }) {
        yield "on";
        await new Promise<void>((res) => signal.addEventListener("abort", () => res()));
        aborted = true;
      }),
    } satisfies RouterRecord;
    const wss = new WebSocketServer({ noServer: true, maxPayload: 1_000_000 });
    const handle = attachWsServer<Ctx>(wss, watching, { path: PATH, allowedOrigins: [ORIGIN] });
    const server = http.createServer();
    server.on("upgrade", (req, socket, head) => handle.handleUpgrade(req, socket, head));
    await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
    cleanups.push(async () => {
      await handle.close();
      server.closeAllConnections();
      await new Promise<void>((res) => server.close(() => res()));
    });
    const ws = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}${PATH}`, {
      headers: { origin: ORIGIN },
    });
    await new Promise((res) => ws.once("open", res));
    ws.send(JSON.stringify({ id: 1, type: "subscribe", path: "watch" }));
    await new Promise((res) => ws.once("message", res));
    ws.terminate();
    await tick(50);
    expect(aborted).toBe(true);
  });
});

describe("attachWsServer: shutdown", () => {
  // A client that never reads, so it never answers the close handshake.
  const deaf = (ws: WebSocket) => (ws as unknown as { _socket: { pause(): void } })._socket.pause();

  it("close() refuses new upgrades with 503", async () => {
    const { connect, handle } = await start();
    await handle.close();
    expect(await connect()).toEqual({ status: 503 });
  });

  it("close() refuses an upgrade whose createContext was still running", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { connect, handle } = await start({
      createContext: async () => {
        await gate;
        return {};
      },
    });
    const pending = connect();
    await tick(20);
    await handle.close();
    release();
    expect(await pending).toEqual({ status: 503 });
  });

  it("close() sends 1001 and resolves after every onClose settled", async () => {
    let saved = false;
    const { connect, handle } = await start({
      onClose: async () => {
        await tick(50);
        saved = true;
      },
    });
    const { ws } = await connect();
    const done = closed(ws!);
    await handle.close();
    expect(saved).toBe(true);
    expect((await done).code).toBe(1001);
  });

  it("close() terminates clients that ignore the close handshake after closeGraceMs", async () => {
    const onClose = vi.fn();
    const { connect, handle } = await start({ closeGraceMs: 50, onClose });
    const { ws } = await connect();
    deaf(ws!);
    const t0 = Date.now();
    await handle.close();
    expect(Date.now() - t0).toBeLessThan(500);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closeWhere terminates a client that ignores the close handshake after closeGraceMs", async () => {
    const onClose = vi.fn();
    const { connect, handle } = await start({ closeGraceMs: 50, onClose });
    const { ws } = await connect();
    deaf(ws!);
    handle.closeWhere(() => true);
    await tick(300);
    expect(handle.size).toBe(0);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("onClose runs once when closeWhere races close()", async () => {
    const onClose = vi.fn();
    const { connect, handle } = await start({ onClose });
    await connect();
    await connect();
    handle.closeWhere(() => true);
    await handle.close();
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("close() is idempotent", async () => {
    const onClose = vi.fn();
    const { connect, handle } = await start({ onClose });
    await connect();
    await Promise.all([handle.close(), handle.close()]);
    await handle.close();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("close() stops the heartbeat and revalidate timers", async () => {
    const check = vi.fn(() => true);
    const { connect, handle } = await start({ heartbeatMs: 20, revalidate: { everyMs: 20, check } });
    await connect();
    await tick(60);
    await handle.close();
    const calls = check.mock.calls.length;
    await tick(200);
    expect(check).toHaveBeenCalledTimes(calls);
  });
});
