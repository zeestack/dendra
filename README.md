# nexus-rpc

[![CI](https://github.com/zeestack/nexus-rpc/actions/workflows/ci.yml/badge.svg)](https://github.com/zeestack/nexus-rpc/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**The typed API framework where every procedure is also an LLM tool and an MCP server — with zero extra work.**

Define a procedure once. Get a typed client, a REST endpoint, an OpenAPI schema,
streaming, real-time subscriptions — **and** an AI tool your agents can call and
an MCP server Claude can connect to. No decorators, no codegen, zero runtime deps.

```ts
export const appRouter = {
  notes: {
    create: route
      .post("/notes")
      .input(s.object({ title: s.string(), body: s.string() }))
      .ai({ description: "Create a note" })        // ← also an LLM/MCP tool
      .handler(({ input, ctx }) => ctx.db.create(input)),
  },
} satisfies RouterRecord;
```

That one definition is now callable as a **typed client method**, a **REST route**
(`POST /notes`), an **OpenAPI** operation, and — because of `.ai()` — a validated
**tool for Claude** over MCP. Same validation, same auth context, every surface.

---

## Why another API framework?

The typed-RPC space is crowded (tRPC, ts-rest, Hono, oRPC) and they're all good at
HTTP. nexus-rpc's wedge is the part they bolt on or skip entirely: **AI- and
MCP-native by construction.** A procedure and an LLM tool are the same shape —
a name, an input schema, a validated handler — so nexus-rpc treats them as one
thing. Mark a procedure `.ai()` and it's instantly:

- an **MCP tool** (stdio for Claude Desktop, or remote HTTP for claude.ai), and
- a tool definition for the **Anthropic / OpenAI** APIs, executed with the same
  validation that guards your HTTP endpoints — so hallucinated arguments are
  rejected and the model inherits the *user's* permissions, not god mode.

Everything else — zero deps, no decorators, no codegen, runtime-agnostic — is
table stakes it also happens to get right.

## One definition → many surfaces

```
                    ┌─▶ typed client            (pure inference, no codegen)
  procedure         ├─▶ REST endpoint + OpenAPI  (give it a path)
  .input(schema)    ├─▶ streaming / real-time    (async generators + pub/sub)
  .ai()             ├─▶ in-process caller         (RSC, zero round-trip)
  .handler(fn)      ├─▶ LLM tool                  (Anthropic / OpenAI)
                    └─▶ MCP server               (stdio + remote HTTP)
```

The router is used **twice from one definition**: as a *type* that flows to the
client (erased at build — zero runtime), and as a *value* the adapters dispatch
against.

## Quickstart

> **Not yet on npm.** The bare name `nexus-rpc` is taken by an unrelated package
> (Temporal's SDK), so a published build would use a scoped name such as
> `@zeestack/nexus-rpc`. For now, use it from source:
>
> ```bash
> git clone https://github.com/zeestack/nexus-rpc
> cd nexus-rpc && npm install && npm run build
> ```

**Define** once:

```ts
import { initNexus, s, type RouterRecord } from "nexus-rpc";

interface Ctx { userId: string | null }
const { route } = initNexus<Ctx>();

export const appRouter = {
  add: route
    .input(s.object({ a: s.number(), b: s.number() }))
    .ai({ description: "Add two numbers" })
    .handler(({ input }) => input.a + input.b),
  chat: route
    .input(s.object({ prompt: s.string() }))
    .stream(async function* ({ input }) {          // streaming = async generator
      for (const token of llm(input.prompt)) yield token;
    }),
} satisfies RouterRecord;

export type AppRouter = typeof appRouter;
```

**Serve** (Next.js App Router — `app/rpc/[...nexus]/route.ts`):

```ts
import { toNextHandler } from "nexus-rpc";
import { appRouter } from "@/server/router";

export const { GET, POST } = toNextHandler(appRouter, {
  createContext: (req) => ({ userId: getSession(req) }),
});
```

Other runtimes use the same router: `toFetchHandler` (Hono/Bun/Deno/Workers),
`toNodeHandler` (`node:http`).

**Call** — the client type comes straight from `typeof appRouter`, no generated files:

```ts
import { createClient } from "nexus-rpc";
import type { AppRouter } from "@/server/router";

const api = createClient<AppRouter>("");
const sum = await api.add({ a: 40, b: 2 });            // number, inferred
for await (const t of api.chat({ prompt: "hi" })) ...  // streaming, inferred
```

In a Server Component, skip HTTP entirely with `createCaller(appRouter, ctx)`.

## The AI / MCP story

```ts
import { toToolset, createToolExecutor, mcpToolDefinitions } from "nexus-rpc";

// LLM tool definitions (Anthropic/OpenAI shapes) from your .ai() procedures:
const tools = toToolset(appRouter, { format: "anthropic" });

// Execute a tool the model chose — validated, scoped to the user's ctx:
const execute = createToolExecutor(appRouter, ctx);
await execute("add", modelProvidedArgs);   // bad args rejected like any input

// MCP: the same procedures become tools Claude can call.
const defs = mcpToolDefinitions(appRouter);
```

Streaming procedures can be tools too — when an LLM/MCP calls a `.stream()` tool,
its chunks are **collected** into the tool result (string chunks are joined; other
chunks become an array), so you can expose streaming work without a special path.

The [Next.js example](examples/nextjs-app/) ships a working MCP server both ways:
a **stdio** server for Claude Desktop (`mcp-server.ts`) and a **remote HTTP**
endpoint (`app/api/mcp/route.ts`) for claude.ai — so Claude can list, create, and
delete your app's data through the exact procedures you already wrote.

## Middleware & auth (`.use()`)

Run logic before a handler — authentication, logging, rate-limiting — and enrich
the context. One `.use()` runs across **every** transport (RPC, REST, the
in-process caller, WebSocket, and AI/MCP tool execution).

```ts
const authed = route.use(({ ctx }) => {
  if (!ctx.token) throw new NexusError("UNAUTHORIZED", "Sign in required");
  return { userId: lookup(ctx.token) };   // merged into ctx, typed downstream
});

export const appRouter = {
  me:     authed.handler(({ ctx }) => ctx.userId),          // ctx.userId is typed
  delete: authed.input(s.object({ id: s.string() }))
                .ai({ description: "Delete an item" })        // tool is auth-guarded too
                .handler(({ ctx, input }) => db.remove(ctx.userId, input.id)),
} satisfies RouterRecord;
```

Middlewares **stack** (each sees the previous one's ctx additions) and **throw a
`NexusError` to reject**. Because an AI/MCP tool runs through the same dispatch
path, a procedure behind `.use(auth)` is authorization-guarded for the model too
— the model inherits the user's permissions, it can't bypass them.

## Class-based controllers (NestJS-style, no decorators)

Prefer classes for grouping and dependency injection? A controller is just a
class whose **fields are procedures** — put an *instance* in the router. You get
NestJS-style structure and constructor DI without decorators, `reflect-metadata`,
or `experimentalDecorators`.

```ts
export class UsersController {
  #db: Db;                                        // #private: not part of the
  constructor(db: Db) { this.#db = db; }          // public type, so the
                                                  // controller stays pure procedures
  list = route.get("/users").handler(() => this.#db.users.all());
  create = route
    .post("/users")
    .input(s.object({ name: s.string() }))
    .ai({ description: "Create a user" })         // still an LLM/MCP tool
    .handler(({ input }) => this.#db.users.insert(input));
}

// A class instance has no index signature, so a class-containing router skips
// `satisfies RouterRecord`; the consumer functions accept it and `Client<R>`
// validates the shape structurally.
export const appRouter = {
  users: new UsersController(db),                 // an instance = a sub-router
  posts: new PostsController(db),
};
```

| NestJS | nexus-rpc |
|---|---|
| `@Controller()` class | plain class with procedure fields |
| `@Get()` / `@Post()` decorators | `.get()` / `.post()` on the builder |
| `@Injectable()` + DI container | constructor injection (`new Ctrl(deps)`) |
| `@Module()` | compose the router object |
| decorators / `reflect-metadata` | none |

Handlers are arrow-function fields, so they close over `this` for injected
dependencies. Keep injected deps in `#private` fields — a public non-procedure
field would break the `RouterRecord` shape. Inference, dispatch, REST, OpenAPI,
and MCP all work unchanged.

## How it compares

| | tRPC | ts-rest | Hono | **nexus-rpc** |
|---|---|---|---|---|
| Typed client, no codegen | ✅ | — | ✅ | ✅ |
| REST URLs + OpenAPI | plugin | ✅ | plugin | ✅ |
| Streaming | links | — | ✅ | ✅ |
| Real-time / WebSocket | subs | — | ✅ | ✅ |
| **LLM tools from procedures** | — | — | — | ✅ |
| **MCP server (stdio + HTTP)** | — | — | — | ✅ |
| Decorators / codegen | none | none | none | **none** |
| Runtime deps | few | few | 0 | **0** |

Not trying to out-tRPC tRPC on HTTP — winning on the AI/MCP seam.

## Also in the box

- **REST + OpenAPI** — give a procedure `.get("/users/:id")` and `.output(schema)`
  (which both **type-checks the handler's return** and documents the response);
  `toRestHandler` serves it and `toOpenApiDocument` emits a 3.1 spec (feed Swagger
  UI or `openapi-typescript` for cross-language clients).
- **Real-time** — a subscription is a streaming procedure fed by a `PubSub`
  interface: `createInMemoryPubSub()` for dev, `createRedisPubSub(client)` for
  multi-instance fan-out (zero-dep — you pass your own redis client).
- **WebSocket** — `attachWs` / `connectWs` multiplex unary calls + subscriptions
  over one socket, same router, outside Next's serverless model.
- **Request batching** — `createClient(url, { batch: true })` collects unary calls
  made in the same tick into one HTTP round-trip (streaming stays direct).
- **Standard Schema** — Zod, Valibot, ArkType, or the built-in `s.*` validators.

## Develop

```bash
npm install
npm run build      # tsup → ESM + CJS + .d.ts in dist/
npm test           # vitest: runtime + type-level inference tests
npm run demo       # boots a server + typed client, exercises everything
npm run demo:restws
```

## Examples

- [`examples/demo.ts`](examples/demo.ts) — caller, unary, validation, streaming, AI tools, pub/sub.
- [`examples/rest-ws-demo.ts`](examples/rest-ws-demo.ts) — REST, OpenAPI, WebSocket transport.
- [`examples/nextjs-app/`](examples/nextjs-app/) — full Next.js 15 app: RPC + REST,
  Server Components, generative-UI chat, real LLM, subdomain multi-tenancy,
  resilient real-time notes, a NestJS-style class controller
  ([`UsersController`](examples/nextjs-app/server/users.controller.ts)) reachable
  over RPC/REST/MCP, and MCP (stdio + remote HTTP).

## Status

**Pre-1.0 (v0.0.1) — experimental.** Implemented and tested: builder/router/dispatch,
Standard Schema validation, Next/Fetch/Node adapters, REST + OpenAPI, inferred
client (unary + streaming), NDJSON streaming with cancellation, WebSocket
transport, AI tools, MCP (stdio + HTTP), in-memory pub/sub. A build pipeline
(tsup) and test suite (vitest, runtime + type tests) are in place.

Not yet: published to npm (planned under a scoped name like `@zeestack/nexus-rpc`),
request batching, auth middleware chains, Redis-backed pub/sub, OAuth for the
remote MCP endpoint. APIs may change before 1.0.

## License

MIT
