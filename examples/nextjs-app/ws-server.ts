// Standalone WebSocket server — run alongside `next dev`. Next's serverless
// runtime can't hold long-lived sockets, but the dendra core is runtime-
// agnostic, so the SAME appRouter runs here with zero changes. Clients (lib/ws.ts)
// get the same typed API over this socket.
//
//   npm i ws
//   node ws-server.ts        (Node 22+ runs .ts directly)

import { WebSocketServer } from "ws";
import { attachWs } from "dendra";
import { appRouter } from "./server/router.ts";
import { db } from "./server/db.ts";
import { pubsub } from "./server/pubsub.ts";
import { tenantFromHost } from "./server/context.ts";

const wss = new WebSocketServer({ port: 4000 });

wss.on("connection", (socket, req) => {
  // Same tenant + auth resolution as the HTTP adapter — from the upgrade request.
  const tenantId = tenantFromHost(req.headers.host ?? "");
  const userId = parseUser(req.headers.cookie ?? "") ?? "anonymous";
  // attachWs wires message/close to a per-connection session. Each subscription
  // gets its own AbortSignal injected into ctx, so disconnects tear down cleanly.
  attachWs(socket, appRouter, { tenantId, userId, db, pubsub });
});

console.log("WS server listening on ws://localhost:4000");

function parseUser(cookie: string): string | null {
  const m = /(?:^|;\s*)uid=([^;]+)/.exec(cookie);
  return m ? decodeURIComponent(m[1]) : null;
}
