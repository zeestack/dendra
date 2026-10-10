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

```bash
npm install nexus-rpc   # pre-1.0 — see Status
```

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

The [Next.js example](examples/nextjs-app/) ships a working MCP server both ways:
a **stdio** server for Claude Desktop (`mcp-server.ts`) and a **remote HTTP**
endpoint (`app/api/mcp/route.ts`) for claude.ai — so Claude can list, create, and
delete your app's data through the exact procedures you already wrote.

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

- **REST + OpenAPI** — give a procedure `.get("/users/:id")` and `.output(schema)`;
  `toRestHandler` serves it and `toOpenApiDocument` emits a 3.1 spec (feed Swagger
  UI or `openapi-typescript` for cross-language clients).
- **Real-time** — a subscription is a streaming procedure fed by a `PubSub`
  interface (in-memory for dev; swap Redis/NATS/Postgres for multi-instance).
- **WebSocket** — `attachWs` / `connectWs` multiplex unary calls + subscriptions
  over one socket, same router, outside Next's serverless model.
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
  resilient real-time notes, and MCP (stdio + remote HTTP).

## Status

**Pre-1.0 (v0.0.1) — experimental.** Implemented and tested: builder/router/dispatch,
Standard Schema validation, Next/Fetch/Node adapters, REST + OpenAPI, inferred
client (unary + streaming), NDJSON streaming with cancellation, WebSocket
transport, AI tools, MCP (stdio + HTTP), in-memory pub/sub. A build pipeline
(tsup) and test suite (vitest, runtime + type tests) are in place.

Not yet: request batching, auth middleware chains, Redis-backed pub/sub, OAuth for
the remote MCP endpoint. APIs may change before 1.0.

## License

MIT
