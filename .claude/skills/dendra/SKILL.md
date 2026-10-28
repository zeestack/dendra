---
name: dendra
description: "Build and extend typed APIs with the dendra framework — define a procedure once and get a typed client, REST + OpenAPI, streaming, real-time, an LLM tool, and an MCP server, with no decorators or codegen. Use when the user asks to scaffold a dendra app or Next.js API, add or change a procedure/route/REST endpoint/subscription, expose procedures to an LLM or as an MCP server (stdio or remote HTTP), consume tools from an external MCP server, or wire a tool-using chat/agent. Also use when a repo already depends on `dendra` and the task touches its router, client, adapters, or AI/MCP layer."
license: MIT
metadata:
  version: "0.1.0"
  homepage: https://github.com/zeestack/dendra
---

# Building with dendra

dendra turns one procedure definition into every surface: a typed client, a REST
endpoint, OpenAPI, streaming, an in-process caller, an LLM tool, and an MCP server.
No decorators, no codegen; the core is zero-dependency. Author in TypeScript and
let inference do the rest — never hand-write client types or `.d.ts`.

## Before writing code

- Check `package.json` for `dendra`; if absent, `npm i dendra`.
- Find the router (usually `server/router.ts`) and the context factory
  (`server/context.ts`). Match the existing file layout and style.
- Optional peers, only if the task needs them: `@anthropic-ai/sdk` for
  `dendra/anthropic`, `react` for `dendra/react`, `next` for `dendra/next`.

## The core pattern — define → serve → call

1. **Define** procedures on the router (`initDendra<Ctx>()` → `route`):
   - Unary: `route.input(schema).handler(({ input, ctx }) => …)`.
   - REST: add a path — `.get("/x")`, `.post("/x")`, `.delete("/x/:id")`.
   - Reads: only `.get()` procedures answer GET (path optional — `route.get()` is
     an RPC-only read). Mutations stay POST; never make them `.get()`.
   - Files: `s.file({ types, maxBytes })` in the input (handler gets a `File`);
     return `file(body, { type, filename, inline? })` for downloads (client gets a
     `Blob`); `urlFor(api.x.get, input)` for `<img src>` (needs `.get()`).
     File-input procedures can't be `.ai()`.
   - Streaming / real-time: `.stream(async function* ({ ctx, signal }) { yield … })`.
     Pass `signal` to `ctx.pubsub.subscribe(topic, { signal })` so the stream stops
     when the client goes away. Clients abort with `api.x(input, { signal })`.
     Across processes, use `createRedisPubSub(client)` or `createPgPubSub(pool)`
     (Postgres LISTEN/NOTIFY; payloads under 8000 bytes, so publish ids).
   - Long-running work: a job, `jobs.define(name, { input, run, key, retries })`
     on `createJobs({ store, pubsub, context })`; `.background(job, map?)` makes a
     procedure enqueue it and return `{ jobId }`; `job.watch(jobId, { signal })`
     in a `.stream()` sends status. Jobs get `context()`, not the request ctx.
   - Typed output (and OpenAPI response): `.output(schema)`.
   - Expose to an LLM/MCP as a tool: `.ai({ description: "…" })` (opt-in).
   - Keep the object `satisfies RouterRecord` — unless it contains a class
     controller instance, which has no index signature (then drop `satisfies`;
     `Client<AppRouter>` still validates it).
   - `export type AppRouter = typeof appRouter;`
2. **Serve** with the right adapter:
   - Next.js App Router: `toNextHandler(appRouter, { prefix: "/rpc/", createContext })`
     in `app/rpc/[...path]/route.ts`, with `export const runtime = "nodejs"` and
     `dynamic = "force-dynamic"` (streaming needs Node, not edge).
   - Else: `toFetchHandler` (Hono/Bun/Deno/Workers), `toNodeHandler` (`node:http`),
     `toRestHandler` (plain REST). `toOpenApiDocument(appRouter, info)` emits 3.1.
3. **Call** with the inferred client: `createClient<AppRouter>(baseUrl, { prefix })`.
   In a Server Component, use `createServerCaller(appRouter, createContext)` from
   `dendra/next` (no HTTP; `ctx` built from `headers()` once per request), with
   calls wrapped in `orPage(call, { signIn })` to turn NOT_FOUND into a 404 and
   UNAUTHORIZED into a sign-in redirect. Client results are typed as JSON
   (`Jsonify`: a `Date` is a `string`); the caller keeps real types.

## Context, auth, middleware

`createContext(req)` builds `ctx` (user/tenant/db/pubsub). dendra never
authenticates — guard with middleware, which runs on **every** transport
(RPC, REST, caller, WS, and AI/MCP tools):

```ts
const authed = route.use(({ ctx }) => {
  if (!ctx.user) throw new DendraError("UNAUTHORIZED", "Sign in");
  return { user: ctx.user };            // merged into ctx, typed downstream
});
```

A tool behind `.use(auth)` is auth-guarded for the model too — it inherits the
user's permissions.

A guard that needs input (e.g. a tenant id) declares it before `.use()`; later
`.input()` calls extend it rather than replace it:

```ts
const inWorkspace = authed
  .input(s.object({ workspaceId: s.integer() }))
  .use(({ ctx, input }) => {            // input typed + validated
    if (!ctx.memberships.has(input.workspaceId)) throw new DendraError("FORBIDDEN", "No");
    return { workspaceId: input.workspaceId };
  });
inWorkspace.input(s.object({ title: s.string() }))   // input: { workspaceId; title }
```

Chained schemas must be objects; the earlier one wins a shared key.

Audit / usage: `.after(({ ctx, path, transport, ok, code, durationMs }) => …)`
runs once a call settles, on every transport. It only sees calls that passed the
`.use()`s before it — put it before auth to also record rejections. Log file
metadata, never file contents.

Guard checks: name middlewares (`.use(mw, { name: "tenant" })`, or a named
function), tag procedures with typed `.meta({ restricted: "approver" })`
(`initDendra<Ctx, Meta>()`), and assert in a test over `inspectRouter(appRouter)`
→ `[{ path, kind, method, restPath?, middlewares, ai, meta }]`.

CSRF: the server only takes POST as JSON (or dendra multipart with `X-Dendra: 1`)
and GET for `.get()` reads. Hand-written `fetch` calls must send
`Content-Type: application/json`. Don't enable `allowFormPosts` without a CSRF
token check. Serve WebSockets with `attachWsServer` (it checks `Origin`);
check it yourself only if you use bare `attachWs`. In the browser,
`createWsConnection<AppRouter>(url)` reconnects and resubscribes on its own.

## AI / MCP

```ts
import { toToolset, createToolExecutor, mcpToolDefinitions,
         toToolSource, mergeToolsets, createMcpToolSource } from "dendra";

const tools = toToolset(appRouter, { format: "anthropic" }); // openai | plain
const execute = createToolExecutor(appRouter, ctx);          // validated, ctx-scoped

// Serve your procedures AS an MCP server: feed mcpToolDefinitions(appRouter) +
// createMcpBridge to the official @modelcontextprotocol/sdk transport.

// Consume an EXTERNAL MCP server and merge its tools with your local ones:
const local = toToolSource(appRouter, ctx, { format: "anthropic" });
const external = await createMcpToolSource(connectedClient, { prefix: "gh." });
const { tools, execute } = mergeToolsets(local, external);   // one flat toolset
```

Optional, opt-in helpers:
- `dendra/anthropic` → `runAgent({ client, model, tools, execute, prompt, system })`
  runs the model↔tool loop, yielding typed `AgentPart`s (text + tool parts).
- `dendra/react` → `useAssistant({ stream, onPart, onDone })` owns the chat thread
  and streaming; the app keeps rendering and side effects.

## The framework ↔ app boundary — enforce it

> Would **every** dendra user want this, regardless of their DB, auth, UI, or
> which servers they connect to? Yes → it belongs in the framework. No → the app.

So put these in the **app**, never inside framework calls: authentication, UI and
navigation, voice, and MCP **connection** management (transports, a connection
registry, OAuth to remote servers). dendra provides only the typed-procedure and
tool-shaping primitives; it takes an already-connected MCP client, never a token.

## Checklist before finishing

- `tsc --noEmit` is clean and the client type infers (no `any`, no codegen files).
- New tool procedures have `.ai({ description })`; sensitive ones sit behind `.use()`.
- Streaming routes run on the Node runtime.
- No auth/UI/connection/OAuth logic leaked into framework wiring.
- Prefer `mergeToolsets` + your own loop unless `runAgent`/`useAssistant` clearly help.

Full reference: the project's `README.md`, `ARCHITECTURE.md`, and the worked
`examples/nextjs-app/`.
