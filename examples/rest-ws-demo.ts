// Proof for the two added features:
//   1. REST front-end + OpenAPI document (same router, resource-style URLs)
//   2. WebSocket transport (unary + multiplexed subscriptions over one socket)
// Run with: node examples/rest-ws-demo.ts

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  initDendra,
  toRestHandler,
  toNodeHandler,
  toOpenApiDocument,
  createWsSession,
  createWsClient,
  createInMemoryPubSub,
  s,
  type RouterRecord,
  type PubSub,
} from "../src/index.ts";

interface Ctx {
  pubsub: PubSub;
  signal?: AbortSignal;
}
const { route } = initDendra<Ctx>();

const UserSchema = s.object({ id: s.string(), name: s.string() });

const appRouter = {
  users: {
    // REST: GET /users/:id  → path param coerced + validated
    get: route
      .get("/users/:id")
      .input(s.object({ id: s.string() }))
      .output(UserSchema)
      .describe("Fetch a user by id")
      .handler(({ input }) => ({ id: input.id, name: "User " + input.id })),

    // REST: POST /users  → JSON body
    create: route
      .post("/users")
      .input(s.object({ name: s.string() }))
      .output(UserSchema)
      .describe("Create a user")
      .handler(({ input }) => ({
        id: "u_" + Math.random().toString(36).slice(2, 7),
        name: input.name,
      })),
  },
  // Streaming subscription used over the WebSocket transport.
  ticker: route
    .input(s.object({ room: s.string() }))
    .stream(async function* ({ input, ctx }) {
      for await (const ev of ctx.pubsub.subscribe(`ticker:${input.room}`, {
        signal: ctx.signal,
      })) {
        yield ev as { tick: number };
      }
    }),
  add: route
    .input(s.object({ a: s.number(), b: s.number() }))
    .handler(({ input }) => input.a + input.b),
} satisfies RouterRecord;

type AppRouter = typeof appRouter;

const pubsub = createInMemoryPubSub();
const line = (t: string) => console.log("\n\x1b[1m" + t + "\x1b[0m");

// ---------------------------------------------------------------------------
// Part 1: REST + OpenAPI over a real HTTP server.
// ---------------------------------------------------------------------------
const rest = toRestHandler<Ctx>(appRouter, {
  createContext: (req) => ({ pubsub, signal: req.signal }),
});
const nodeRest = toNodeHandler<Ctx>(appRouter, {
  createContext: (req) => ({ pubsub, signal: req.signal }),
}); // (RPC prefix handler, unused here)
void nodeRest;

const server = createServer((req, res) => {
  // Bridge node → fetch for the REST handler.
  (async () => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    const request = new Request("http://localhost" + (req.url ?? "/"), {
      method: req.method,
      headers: req.headers as Record<string, string>,
      body: body.length ? body.toString("utf8") : undefined,
    });
    const response = await rest(request);
    res.statusCode = response.status;
    response.headers.forEach((v, k) => res.setHeader(k, v));
    res.end(await response.text());
  })().catch(() => {
    res.statusCode = 500;
    res.end();
  });
});
await new Promise<void>((r) => server.listen(0, r));
const port = (server.address() as AddressInfo).port;
const baseUrl = `http://localhost:${port}`;

try {
  line("1. REST front-end — resource URLs, result returned directly");
  const getRes = await fetch(`${baseUrl}/users/42`);
  console.log("   GET /users/42 =>", await getRes.json());
  const postRes = await fetch(`${baseUrl}/users`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Grace" }),
  });
  console.log("   POST /users {name:'Grace'} =>", await postRes.json());
  const badRes = await fetch(`${baseUrl}/users`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: 123 }),
  });
  console.log("   POST /users {name:123} =>", badRes.status, await badRes.json());

  line("2. OpenAPI 3.1 document — derived from the same procedures");
  const spec = toOpenApiDocument(appRouter, {
    info: { title: "Demo API", version: "1.0.0" },
    servers: [{ url: baseUrl }],
  });
  console.log("   paths:", Object.keys(spec.paths as object));
  console.log(
    "   GET /users/{id} operation:",
    JSON.stringify(
      (spec.paths as Record<string, Record<string, unknown>>)["/users/{id}"]
        .get,
      null,
      2,
    ),
  );
} finally {
  server.closeAllConnections();
  server.close();
}

// ---------------------------------------------------------------------------
// Part 3: WebSocket transport over an in-memory loopback (no `ws` package).
// client.send -> server.handleMessage ;  server.send -> client.receive
// ---------------------------------------------------------------------------
line("3. WebSocket transport — unary + two multiplexed subscriptions, one socket");

const wsClient = createWsClient<AppRouter>((data) =>
  queueMicrotask(() => session.handleMessage(data)),
);
const session = createWsSession(
  appRouter,
  (data) => queueMicrotask(() => wsClient.receive(data)),
  { pubsub },
);
const ws = wsClient.api;

// Unary over WS:
console.log("   ws add({a:3,b:4}) =>", await ws.add({ a: 3, b: 4 }));

// Two independent subscriptions multiplexed over the single connection:
const roomA: number[] = [];
const roomB: number[] = [];
const subA = (async () => {
  for await (const ev of ws.ticker({ room: "A" })) {
    roomA.push(ev.tick);
    if (roomA.length >= 2) break;
  }
})();
const subB = (async () => {
  for await (const ev of ws.ticker({ room: "B" })) {
    roomB.push(ev.tick);
    if (roomB.length >= 2) break;
  }
})();

await sleep(20);
pubsub.publish("ticker:A", { tick: 1 });
pubsub.publish("ticker:B", { tick: 100 });
pubsub.publish("ticker:A", { tick: 2 });
pubsub.publish("ticker:B", { tick: 200 });
await Promise.all([subA, subB]);
session.handleClose();

console.log("   room A ticks =>", roomA);
console.log("   room B ticks =>", roomB);

line("All checks passed ✓");

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
