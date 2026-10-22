import http from "node:http";
import { expectTypeOf, test } from "vitest";
import { WebSocketServer } from "ws";
import { attachWsServer, initDendra, type RouterRecord } from "../src/index.ts";

const { route } = initDendra();
const router = { ping: route.handler(() => "pong") } satisfies RouterRecord;

test("a real ws server, IncomingMessage and Duplex fit with no casts", () => {
  const handle = attachWsServer(new WebSocketServer({ noServer: true }), router, {
    path: "/x",
    allowedOrigins: [],
  });
  http.createServer().on("upgrade", (req, socket, head) => {
    expectTypeOf(handle.handleUpgrade(req, socket, head)).toEqualTypeOf<boolean>();
  });
});

test("a context declared as an interface is accepted", () => {
  interface AppCtx {
    user: { id: string } | null;
  }
  const { route: r } = initDendra<AppCtx>();
  const appRouter = { me: r.handler(({ ctx }) => ctx.user) } satisfies RouterRecord;
  const handle = attachWsServer<AppCtx>(new WebSocketServer({ noServer: true }), appRouter, {
    path: "/x",
    allowedOrigins: [],
    createContext: () => ({ user: null }),
  });
  handle.closeWhere((ctx) => ctx.user?.id === "a");
});
