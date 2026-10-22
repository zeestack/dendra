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
