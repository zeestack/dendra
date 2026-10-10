# dendra × Next.js App Router — example

Illustrative source to drop into a **Next.js 15** App Router project. It shows
every integration point: RPC, REST, OpenAPI, Server Components, live
subscriptions, AI streaming, AI tools, and the standalone WebSocket server.

## Run it (this folder is a real app)

```bash
cd examples/nextjs-app
npm install          # installs Next + React and links dendra from source
npm run dev          # http://localhost:3100
npm run ws           # (optional, separate terminal) WebSocket server on :4000
```

`dendra` is linked from the repo (`"dendra": "file:../.."`) and compiled by
Next via `transpilePackages`, so there's no publish step.

## Demo all features in one place

Open **http://localhost:3100/demo** — nine interactive cards, each running a real
call against the live router:

1. Unary RPC (typed client) · 2. Query · 3. REST front-end · 4. Validation
guardrail (400) · 5. Streaming (`for await`) · 6. **Real-time subscription**
(create a note in card 1 → it appears live in card 6) · 7. AI tools + execution ·
8. OpenAPI 3.1 · 9. WebSocket (needs `npm run ws`).

Also: `/` (server-rendered notes via `createCaller`) and `/chat` (AI streaming).

## Expose it to Claude over MCP

The `.ai()`-exposed procedures become MCP tools, so Claude (Desktop or Code) can
read and write your app. [`mcp-server.ts`](mcp-server.ts) lists tool schemas from
the router and proxies execution to the **running app** over the typed client —
so Claude's actions hit real, tenant-scoped data.

```bash
npm i @modelcontextprotocol/sdk
npm run dev            # app must be running
node mcp-test.ts       # verify: lists tools, creates + lists a note via MCP
```

**Claude Desktop** — add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "dendra-notes": {
      "command": "node",
      "args": ["/ABS/PATH/examples/nextjs-app/mcp-server.ts"],
      "env": { "APP_URL": "http://localhost:3100", "TENANT": "acme", "MCP_USER": "claude" }
    }
  }
}
```

**Claude Code** — from the app folder:

```bash
claude mcp add dendra-notes \
  --env APP_URL=http://localhost:3100 --env TENANT=acme --env MCP_USER=claude \
  -- node "$(pwd)/mcp-server.ts"
```

Then ask Claude to "list my notes" or "create a note titled X" — it calls the
tools, which hit the live app. Tools exposed: `notes.list`, `notes.create`,
`ai.summarize` (add `.ai()` to any procedure to expose more).

> Two bridge modes: this example proxies to the running app (shared live data).
> For a server with no running app, the library's `createMcpBridge(router, ctx)`
> runs the router in-process instead.

### Remote MCP for claude.ai web (OAuth — the app's job)

The remote endpoint ([`app/api/mcp/route.ts`](app/api/mcp/route.ts)) is reachable
over a URL. **Auth is the app's responsibility — the framework stays
auth-agnostic.** This example ships an app-level, demo OAuth 2.1 authorization
server (PKCE + dynamic client registration) so claude.ai web can connect:

- `/.well-known/oauth-protected-resource` + `/.well-known/oauth-authorization-server` — discovery
- `/oauth/register`, `/oauth/authorize`, `/oauth/token` — the flow (see [`server/oauth-store.ts`](server/oauth-store.ts))

Enable it with `MCP_OAUTH=1`; the endpoint then returns `401` with a
`WWW-Authenticate` pointing at the discovery doc, which is how an MCP client
starts the flow. Expose the app over public HTTPS (tunnel/deploy) and add
`<url>/api/mcp` as a custom connector in claude.ai.

> ⚠️ The `/oauth/authorize` here **auto-approves** as a fixed user — it's a
> reference, not production auth. A real app plugs in its own login/consent/IdP.
> Set `MCP_TOKEN=…` instead for a simpler static-bearer mode behind a private tunnel.

## Multi-tenancy by subdomain

Tenancy is resolved once in [`server/context.ts`](server/context.ts) from the
request host and placed on `ctx.tenantId`; every procedure is then scoped
automatically (data queries and pub/sub topics). Handlers never parse hosts.

`*.localhost` resolves to 127.0.0.1 in modern browsers, so you can try it with no
`/etc/hosts` edits:

- **http://acme.localhost:3100** → tenant `acme`
- **http://beta.localhost:3100** → tenant `beta`
- **http://localhost:3100** → tenant `public`

Notes created under one tenant are invisible to the others — the same
`createContext` runs for the RPC, REST, and WebSocket adapters, so tenancy holds
across all of them.

## File map

```
server/
  db.ts            data layer stub (swap for Prisma/Drizzle)
  pubsub.ts        pub/sub singleton (swap for Redis in prod)
  context.ts       Ctx + createContext (HTTP) + directContext (in-process)
  router.ts        ← the single source of truth: all procedures
app/
  rpc/[...path]/route.ts   RPC mount        → the typed client talks here
  api/[...rest]/route.ts    REST mount       → resource URLs, webhooks, 3rd parties
  openapi.json/route.ts     OpenAPI 3.1 doc  → Swagger UI / client codegen
  api/agent/route.ts        AI agent loop    → toToolset + createToolExecutor
  page.tsx                  Server Component → createCaller (no HTTP)
  notes-client.tsx          Client Component → typed mutation + live subscription
  chat/…                    AI streaming via for-await
lib/
  api.ts           browser RPC client   (createClient<AppRouter>)
  ws.ts            browser WS client    (connectWs<AppRouter>)
ws-server.ts       standalone WebSocket server (same router, outside serverless)
```

## Setup in a real project

```bash
npx create-next-app@latest my-app --ts --app
cd my-app
npm i dendra
# optional extras used by the example:
npm i ws @anthropic-ai/sdk
npm i -D @types/ws
```

Copy `server/`, `lib/`, the `app/` routes/components, and `ws-server.ts` in.
Ensure `tsconfig.json` has the `@/*` path alias (create-next-app sets this up).

## The through-line

Everything flows from **`server/router.ts`**. Define a procedure once:

- it's callable as **RPC** (`api.notes.list()` from the browser),
- callable **in-process** (`createCaller` in a Server Component, zero round-trip),
- exposed as **REST** when you give it a path (`GET /api/notes`),
- documented in **OpenAPI** automatically,
- streamable (`for await` over `api.ai.chat(...)` or `api.notes.watch()`),
- and an **LLM tool** when you add `.ai()`.

## Runtime notes

- **Streaming on Next**: route handlers that stream use `runtime = "nodejs"` and
  `dynamic = "force-dynamic"`. Holding many long-lived HTTP streams on serverless
  is limited/costly — fine for moderate use; for heavy real-time use the WS server.
- **WebSockets**: Next serverless can't host a long-lived socket, so Tier-2
  real-time runs in `ws-server.ts` (plain Node). It imports the **same**
  `appRouter` — no rewrite — which is the payoff of keeping the core
  runtime-agnostic. Run it beside `next dev`:
  ```bash
  node ws-server.ts
  ```
- **Auth**: `createContext` reads the session from the request; the WS server
  reads it from the upgrade request. Procedures never see `next/*` — they only
  see `Ctx`, so they run identically under every adapter.
