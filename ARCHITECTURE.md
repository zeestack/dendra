# Architecture: the framework vs. the app

<div align="center">
<img src="assets/arch-framework.png" alt="dendra framework architecture" width="820">
<br>
<sub>The framework · <a href="https://products.techfoundry.io/dendra/architecture/framework.html">interactive</a></sub>
<br><br>
<img src="assets/arch-example.png" alt="dendra example app architecture" width="820">
<br>
<sub>The example app · <a href="https://products.techfoundry.io/dendra/architecture/example.html">interactive</a></sub>
</div>

This repo has two layers, and keeping them separate is the whole design:

- **The framework** — `dendra` (the `src/` package). Generic, reusable plumbing.
- **The app** — the Next.js example (`examples/nextjs-app/`). A real product built
  *on* dendra.

The guiding rule throughout:

> **The framework is generic plumbing anyone could reuse. The app is everything
> specific to _this_ product — its data, its auth, its UI, its connections.**

One question decides which side any feature belongs to:

> _Would **every** dendra user want this, regardless of their database, auth, UI,
> or which servers they connect to?_
>
> - **Yes →** framework.
> - **No →** app.

That test is why auth, navigation, voice, MCP connection management, and the OAuth
flow all live in the example — and why only the tool-shaping primitives went into
the framework.

---

## The framework — `dendra` (`src/`)

A standalone package: **zero runtime dependencies, no decorators, no codegen.** It
knows nothing about your database, your users, Next.js auth, OAuth, voice, or any
specific MCP server. You define a procedure once and it becomes every surface.

| Concern | API | File |
|---|---|---|
| Builder / router / dispatch | `initDendra()` → `route.input().handler()` / `.stream()` | `core.ts` |
| Typed client (pure inference) | `createClient<AppRouter>()` | `client.ts` |
| In-process caller (Server Components, tests) | `createCaller()` | `caller.ts` |
| HTTP / fetch / Node adapters | `toFetchHandler`, `toNodeHandler`, `toRestHandler` | `server.ts` |
| Next.js adapter | `toNextHandler` | `adapters.ts` |
| OpenAPI 3.1 | `toOpenApiDocument` | `openapi.ts` |
| Middleware | `.use()` | `core.ts` |
| Schemas (Standard Schema + built-ins) | `s.*` | `schema.ts` |
| Real-time pub/sub | `createInMemoryPubSub`, `createRedisPubSub` | `pubsub.ts`, `redis-pubsub.ts` |
| WebSocket transport | `attachWs` / `connectWs` | `ws.ts` |
| Procedures → LLM tools | `.ai()`, `toToolset`, `createToolExecutor` | `tools.ts` |
| **Your app AS an MCP server** | `mcpToolDefinitions`, `createMcpBridge` | `mcp.ts` |
| **Consume OTHER MCP servers** | `createMcpToolSource`, `mergeToolsets`, `toToolSource` | `tools.ts`, `mcp.ts` |
| Errors | `DendraError`, `DendraClientError` | `errors.ts` |
| _Optional:_ agentic loop (`dendra/anthropic`) | `runAgent` | `anthropic.ts` |
| _Optional:_ chat hook (`dendra/react`) | `useAssistant` | `react.ts` |

**Optional subpaths.** `dendra/anthropic` and `dendra/react` are separate exports
with **optional peer dependencies** (`@anthropic-ai/sdk`, `react`). They remove
the boilerplate of a tool-using chat — the model↔tool loop and the chat
thread/streaming — but importing them is opt-in, so `import … from "dendra"` stays
zero-dependency. They exchange one shared `AgentPart` type (defined dep-free in
`agent.ts`), which is what lets the loop's output feed the hook directly.

### The subtle one: consuming external MCP servers

`createMcpToolSource(client)` takes an **already-connected** MCP client — anything
matching the two-method `McpClientLike` shape (the official
`@modelcontextprotocol/sdk` `Client` satisfies it as-is) — and turns its tools
into a dendra `ToolSource`. `mergeToolsets(local, ...external)` blends your
procedures and remote tools into one flat `{ tools, execute }` for an agent loop,
routing each call to the source that owns the name.

**It never opens a connection and never sees a token.** That's deliberate: it's
what keeps the framework zero-dependency and auth-agnostic. Opening sockets and
holding credentials is the app's job (see below).

---

## The app — the example (`examples/nextjs-app/`)

A real Next.js product built on dendra. Everything here is specific to this app
and would be different in yours.

| File / route | What it owns | Why it's the app's job |
|---|---|---|
| `server/router.ts` | the actual procedures (notes, users, ai.*, ui.*, mcp.*) | your business logic |
| `server/db.ts`, `server/schema.ts` | Drizzle + SQLite | your data layer |
| `server/context.ts` | per-request `ctx`: tenant/user resolution, `ctx.origin` | your auth & multi-tenancy |
| `server/users.controller.ts` | a NestJS-style class controller | your code style |
| `server/llm.ts` | Anthropic wiring, the agentic loop | your model integration |
| `server/pubsub.ts` | which pub/sub implementation to use | your infra choice |
| `app/rpc/[...path]/route.ts` | mounts the RPC handler | wiring |
| `app/api/[...rest]/route.ts` | mounts the REST handler | wiring |
| `app/api/mcp/route.ts` + `app/oauth/*` + `app/.well-known/*` | this app **as** an MCP server, with its OAuth policy | your server's auth |
| `server/mcp-tools.ts` | the **connection registry** — opens/holds/closes MCP clients and transports (HTTP / stdio / in-memory) | connection lifecycle is app infra |
| `server/mcp-oauth.ts` + `app/mcp/callback/route.ts` | the OAuth **client** flow (discovery, dynamic registration, PKCE, token store) | who holds tokens is the app's business |
| `server/external-mcp-server.ts` | a demo weather/time MCP server | just a fixture for the demo |
| `app/assistant/page.tsx` | chat UI, generative-UI cards, **voice** (STT/TTS), the **+ Add connector** panel | UI is always app-level |
| `app/page.tsx`, `app/demo`, `app/chat` | pages | your UI |

---

## The seam, concretely: the MCP connector

When you click **+ Add connector** in the assistant and connect a remote MCP
server, this is who does what:

```
   APP (examples/nextjs-app)                        FRAMEWORK (dendra)
   ─────────────────────────────────────────       ──────────────────────────
   user clicks "+ Add connector"   (page.tsx)
        │
   mcp.connect procedure           (router.ts)
        │
   connectMcpServer                (mcp-tools.ts)   ← opens the transport,
        │  runs OAuth if needed    (mcp-oauth.ts)      holds the Client,
        │  /mcp/callback exchanges code→tokens          manages tokens
        ▼
   a connected MCP Client  ────────────────────▶   createMcpToolSource(client)
                                                    mergeToolsets(local, external)
                                                         │
   ai.assistant hands tools+execute                      ▼
   to the agent loop             ◀────────────── one flat toolset
```

The app does all the **connecting, authing, and holding**. dendra only takes the
finished client and does the **tool plumbing**. The model can't tell a local
procedure from a remote MCP tool — but every line that touches a credential or a
socket is in the app.

---

## Why specific things are app-level, not framework

These came up as explicit design decisions:

- **Auth** — a procedure's `ctx` is built by the app (`createContext`). dendra
  never authenticates anyone; it just runs handlers with whatever `ctx` you give
  it. Both the MCP *server* auth (`app/oauth/*`) and the MCP *client* OAuth
  (`mcp-oauth.ts`) are app code.
- **Navigation** — `ui.navigate` is a normal procedure that returns a path; the
  **page** performs `router.push`. dendra has no idea the DOM or a router exists.
- **Voice** — STT/TTS are browser APIs wrapping a plain RPC call
  (`api.ai.assistant`). Pure UI; it lives in `page.tsx`.
- **MCP connection management** — transports, connection lifecycle, retries, the
  registry of live connections: all `mcp-tools.ts`. dendra consumes the result,
  not the process.

If you fork this example into your own product, you rewrite the app layer and keep
`dendra` untouched.
