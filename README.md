# nexus-rpc

A lightweight, **decorator-free, codegen-free** typed RPC/REST framework for
Next.js — and any Web-standard runtime. Define a procedure once; get an RPC call,
a REST endpoint, an OpenAPI schema, a fully-typed client, and an LLM tool.

The typed-API lane (tRPC / ts-rest), with the weight removed:

| | Typical framework | **nexus-rpc** |
|---|---|---|
| Routing | decorators / class controllers | plain functions |
| Typed client | **codegen** (generated package) | **pure inference** (`typeof router`) |
| Validation | one library (Zod) | any **Standard Schema** (Zod/Valibot/ArkType/built-in) |
| Runtime | framework-coupled | Web-standard core; Next is one adapter |
| Deps | several | **zero** runtime deps |

## The idea in one picture

One procedure definition is consumed many ways:

```
                    ┌─▶ runtime validation      (Standard Schema)
  procedure  ───────┼─▶ typed client            (inference, no codegen)
  (plain object)    ├─▶ OpenAPI / JSON Schema
                    ├─▶ LLM tool definition      (.ai() opt-in)
                    └─▶ dispatch                 (RPC / REST / in-process / WS)
```

The router is used **twice from one definition**: as a *type* that flows to the
client (zero runtime), and as a *value* the server adapter dispatches against.

## Define

```ts
import { initNexus, s, type RouterRecord } from "nexus-rpc";

interface Ctx { userId: string | null }
const { route } = initNexus<Ctx>();

export const appRouter = {
  math: {
    add: route
      .input(s.object({ a: s.number(), b: s.number() }))
      .ai({ description: "Add two numbers" })   // opt-in LLM tool
      .handler(({ input }) => input.a + input.b),
  },
  chat: route
    .input(s.object({ prompt: s.string() }))
    .stream(async function* ({ input }) {        // streaming = async generator
      for (const w of reply(input.prompt)) yield w;
    }),
} satisfies RouterRecord;

export type AppRouter = typeof appRouter;
```

## Serve (Next.js App Router)

`app/rpc/[...nexus]/route.ts`:

```ts
import { appRouter } from "@/server/router";
import { toNextHandler } from "nexus-rpc";

export const { GET, POST } = toNextHandler(appRouter, {
  createContext: (req) => ({ userId: getSession(req) }),
});
```

Other runtimes: `toFetchHandler` (Hono/Bun/Deno/Workers), `toNodeHandler`
(`node:http`). Same router, no rewrite.

## Call (typed client, no generated files)

```ts
import { createClient } from "nexus-rpc";
import type { AppRouter } from "@/server/router";

const api = createClient<AppRouter>("");

const sum = await api.math.add({ a: 40, b: 2 });   // number, inferred
for await (const token of api.chat({ prompt: "hi" })) process.stdout.write(token);
```

In a Server Component, skip HTTP entirely:

```ts
import { createCaller } from "nexus-rpc";
const caller = createCaller(appRouter, { userId });
const sum = await caller.math.add({ a: 1, b: 2 });
```

## AI tools

```ts
import { toToolset, createToolExecutor } from "nexus-rpc";

const tools = toToolset(appRouter, { format: "anthropic" });  // → tool defs
const execute = createToolExecutor(appRouter, ctx);           // validated run
await execute("math.add", modelProvidedArgs); // hallucinated args are rejected
```

Only `.ai()`-exposed procedures are tools (opt-in). Execution runs through the
same validation + context as HTTP, so the model inherits the user's permissions.

## Real-time / multi-user

A subscription is a streaming procedure fed by a pub/sub bus:

```ts
bump:  route.input(s.object({ room: s.string(), by: s.number() }))
  .handler(({ input, ctx }) => ctx.pubsub.publish(`c:${input.room}`, input.by)),

watch: route.input(s.object({ room: s.string() }))
  .stream(async function* ({ input, ctx }) {
    for await (const ev of ctx.pubsub.subscribe(`c:${input.room}`, { signal: ctx.signal }))
      yield ev;
  }),
```

`PubSub` is an interface — in-memory for dev, swap Redis/NATS/Postgres for
multi-instance fan-out. True WebSocket transport runs the same router outside
Next's serverless model (standalone Node/Bun) — see the architecture notes.

## Run the demo

```bash
npm install
npm run typecheck   # proves end-to-end inference
npm run demo        # boots a server + typed client, exercises everything
```

## REST + OpenAPI

Give a procedure a path and it also answers as REST; the OpenAPI doc is derived
from the same schemas:

```ts
const api = {
  users: {
    get: route.get("/users/:id")
      .input(s.object({ id: s.string() }))
      .output(UserSchema)              // documents the 200 response
      .handler(({ input }) => db.find(input.id)),
  },
} satisfies RouterRecord;

toRestHandler(api);                     // GET /users/:id  → result JSON
toOpenApiDocument(api, { info: { title: "API", version: "1.0.0" } });
```

Feed the spec to Swagger UI, or to `openapi-typescript` / `openapi-generator`
for clients in other languages — the cross-repo / cross-language escape hatch,
with no codegen pipeline of your own.

## WebSocket (Tier-2 real-time)

Unary calls and many subscriptions multiplexed over one socket, using the same
router. Transport-agnostic sessions bind to the `ws` package, Bun/Deno/Workers,
or an in-memory loopback:

```ts
// server (standalone Node — Next serverless can't hold a socket)
import { attachWs } from "nexus-rpc";
wss.on("connection", (socket) => attachWs(socket, appRouter, ctx));

// browser
import { connectWs } from "nexus-rpc";
const api = connectWs<AppRouter>(new WebSocket("ws://localhost:4000"));
for await (const ev of api.notes.watch()) { /* ... */ }
```

## Examples

- [`examples/demo.ts`](examples/demo.ts) — caller, unary, validation, streaming,
  AI tools, pub/sub (run `npm run demo`).
- [`examples/rest-ws-demo.ts`](examples/rest-ws-demo.ts) — REST, OpenAPI, and the
  WebSocket transport (`npm run demo:restws`).
- [`examples/nextjs-app/`](examples/nextjs-app/) — full Next.js 15 App Router
  integration: RPC + REST mounts, Server Components, live subscriptions, AI
  streaming + tools, standalone WS server.

## Status

Proof-of-concept (v0.0.1). Implemented: builder, router, dispatch, Standard
Schema validation, `toFetchHandler`/`toNodeHandler`/`toNextHandler`,
`toRestHandler` + `toOpenApiDocument`, `createCaller`, inferred client (unary +
streaming), NDJSON streaming with abort/cancellation, WebSocket transport
(`createWsSession`/`createWsClient` + `attachWs`/`connectWs`),
`toToolset`/`createToolExecutor`, in-memory pub/sub.
Not yet: request batching, auth middleware chains, Redis-backed pub/sub.
