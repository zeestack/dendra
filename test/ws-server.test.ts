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
} from "../src/index.ts";

type Ctx = { user?: string | null };
const { route } = initDendra<Ctx>();
const router = {
  whoami: route.handler(({ ctx }) => ctx.user ?? null),
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

