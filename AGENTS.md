# Building with dendra — agent guide

Guidance for coding agents (Claude Code, Cursor, Codex, …) writing apps that use
**dendra**. Keep this short context in mind; the full story is in
[README.md](README.md) and [ARCHITECTURE.md](ARCHITECTURE.md).

## What it is

A typed, decorator-free, codegen-free RPC/REST framework for Next.js and any
Web-standard runtime. You define a procedure **once**; it becomes a typed client,
a REST endpoint, OpenAPI, streaming, an in-process caller, an **LLM tool**, and an
**MCP server**. Core is zero-dependency.

## Install / scaffold

A new app? Scaffold it (templates: `minimal`, `mcp`):

```bash
npm create dendra-app@latest my-app
```

Adding to an existing project:

```bash
npm i dendra
# optional helpers, only if used:
npm i @anthropic-ai/sdk   # for dendra/anthropic (runAgent)
npm i react               # for dendra/react (useAssistant)
npm i next                # for dendra/next (createServerCaller, orPage)
```

## The one pattern: define → serve → call

```ts
// server/router.ts
import { initDendra, s, type RouterRecord } from "dendra";
import type { Ctx } from "./context";

const { route } = initDendra<Ctx>();

export const appRouter = {
  add: route
    .input(s.object({ a: s.number(), b: s.number() }))
    .handler(({ input }) => input.a + input.b),

  notes: {
    list: route.get("/notes").handler(({ ctx }) => ctx.db.notes.all()),
    create: route
      .post("/notes")
      .input(s.object({ title: s.string(), body: s.string() }))
      .ai({ description: "Create a note" })      // ← also an LLM/MCP tool
      .handler(({ input, ctx }) => ctx.db.notes.insert(input)),
    watch: route.stream(async function* ({ ctx, signal }) { // streaming = async generator
      for await (const ev of ctx.pubsub.subscribe("notes", { signal })) yield ev;
    }),
  },
} satisfies RouterRecord;

export type AppRouter = typeof appRouter;
```

```ts
// app/rpc/[...path]/route.ts  (Next.js App Router)
import { toNextHandler } from "dendra";
import { appRouter } from "@/server/router";
import { createContext } from "@/server/context";
export const { GET, POST } = toNextHandler(appRouter, { prefix: "/rpc/", createContext });
export const runtime = "nodejs";          // streaming needs Node, not edge
export const dynamic = "force-dynamic";
```

```ts
// lib/api.ts  (browser client — type from typeof appRouter, NO codegen)
import { createClient } from "dendra";
import type { AppRouter } from "@/server/router";
export const api = createClient<AppRouter>("", { prefix: "/rpc/" });
// api.add({ a, b }) → Promise<number>; for await (const ev of api.notes.watch()) …
// Every call takes an optional 2nd arg: { signal } to abort, { batch: false }.
```

In a Server Component, skip HTTP with `createServerCaller(appRouter,
createContext)` from `dendra/next` — it builds `ctx` from `headers()` with the
route handler's own `createContext`, once per request — and wrap calls in
`orPage(call, { signIn })` so NOT_FOUND/BAD_REQUEST become `notFound()` and
UNAUTHORIZED a sign-in redirect. Don't rebuild a `Request` from `headers()` by hand.

## Conventions that aren't obvious from the types

- **Context is the app's job.** `createContext(req)` builds `ctx` (auth, tenant,
  db, pubsub). dendra never authenticates — guard procedures with `.use()`:
  ```ts
  const authed = route.use(({ ctx }) => { if (!ctx.user) throw new DendraError("UNAUTHORIZED","…"); return { user: ctx.user }; });
  ```
  A tool behind `.use(auth)` is auth-guarded for the model too.
- **Guards that need input** declare it first: `route.input(s.object({
  workspaceId: s.integer() })).use(({ input }) => …)` — `input` is typed and
  validated. A later `.input()` *extends* it (objects only; the earlier schema
  wins a shared key). Don't re-parse raw input in a guard or repeat the field.
- **Errors the user or model should read are `DendraError`s.** Anything else
  (a DB driver's error, a `TypeError`) reaches HTTP clients, WebSockets, job
  snapshots and tools as `INTERNAL: Internal error`, and is logged. Don't send
  raw error text to clients or the model yourself.
- **Reads are `.get()`.** Only `.get()` procedures (path optional) answer GET;
  others get 405. POST must be JSON (415 otherwise). The client handles this.
- **Files:** `s.file({ types, maxBytes })` in the input (handler gets a `File`;
  client sends multipart); return `file(body, { type, filename, inline? })` for
  downloads (client gets a `Blob`); `urlFor(api.x.get, input)` for `<img src>`
  — needs `.get()`. File-input procedures can't be `.ai()`. Don't enable
  `allowFormPosts` without your own CSRF token check.
- **After-hooks for audit/usage.** `.after(({ ctx, path, transport, ok, result,
  error, code, durationMs }) => …)` runs once the call settles, on every transport
  (incl. AI tools). Awaited; throws are logged, not returned. It only sees calls
  that passed the `.use()`s before it — place it before auth to record rejections.
- **Assert guards in a test.** `inspectRouter(appRouter)` → `[{ path, kind,
  method, restPath?, middlewares, ai, confirm, noAi, meta }]`. Middlewares are listed by
  `.use(mw, { name })`, else the function's name (inline arrows: `"anonymous"`).
  Tag procedures with `.meta({ restricted: "approver" })`, typed by
  `initDendra<Ctx, Meta>()`. Don't read `proc.middlewares` internals.
- **Client results are JSON-typed.** `createClient` results are `Jsonify<Out>`
  (a `Date` arrives as a `string`); `createCaller` keeps real types
  (`Caller<R>`). Don't cast client results back to `Date` — parse them.
- **Streaming tools are bounded.** A `.stream()` with `.ai()` answers with the
  chunks collected in `timeoutMs` (default 30 s) or `maxItems` (1,000), then
  its `signal` aborts: `.ai({ timeoutMs: 5_000 })` for a "watch for 5 s" tool.
  Pass `{ signal }` as the executor's third argument to cancel a call.
- **Streams stop with their consumer.** A `.stream()` handler gets `signal`,
  aborted when the client disconnects, cancels, unsubscribes, or aborts its own
  `{ signal }`. Pass it to `pubsub.subscribe(topic, { signal })` or long work
  won't stop. Multi-instance pub/sub: `createRedisPubSub(client)` or
  `createPgPubSub(pool)` (LISTEN/NOTIFY; messages under 8000 bytes — publish
  ids). Batched calls (`batch: true`) stream back as each settles.
- **SSE when proxies buffer.** `createClient(url, { streamFormat: "sse" })`
  streams as Server-Sent Events instead of NDJSON. The server picks the format
  from `Accept`, pings every 15 s (server option `heartbeatMs`), and ends with a
  `done` event. A bare `EventSource` needs `.get()`; close it on `done`. For
  proxy, compression and timeout settings, see "Deploying streams" in the README.
- **Long work goes in a job,** not `after()`: `jobs.define(name, { input, run, key,
  retries })`, then `route.….background(job, map?)` returns `{ jobId }` and
  `job.watch(jobId, { signal })` streams status. In the browser follow it with
  `useJob(jobId, (id, signal) => api.x.watch({ jobId: id }, { signal }))` from
  `dendra/react` (or `followJob` from `dendra`): it reconnects and stops on
  succeeded/failed — don't poll or hand-roll that loop. A job's ctx comes from
  `createJobs({ context })`, never the request — pass tenant/user ids via `map`.
  Call `jobs.start()` in processes that run jobs.
- **`.ai()` is opt-in.** Only `.ai()`-marked procedures are exposed as tools.
  Mark ones a model must never call `.noAi()` (throws if `.ai()` is added). For
  tools a person must approve, `.ai({ confirm: true })` + `createApprovals(router,
  { scope })` passed as `createToolExecutor(router, ctx, { approvals })`: the call
  returns `{ status: "pending_approval", actionId }`; `approvals.approve(id, ctx)`
  runs it with the approver's ctx (by design; `proposer: (ctx) => id` records
  `action.proposedBy`). Don't build your own pending-action flow.
- **WebSockets:** `attachWsServer(wss, router, { path, allowedOrigins,
  createContext })` on a `ws` server made with `{ noServer: true, maxPayload:
  1_000_000 }`; call `handleUpgrade` from your HTTP server's `upgrade` event
  (it returns `false` for other paths). `closeWhere(ctx => …)` on sign-out,
  `await close()` on shutdown. Don't hand-roll upgrade or Origin handling.
  In the browser use `createWsConnection<AppRouter>(url)`: it reconnects and
  resubscribes; refetch on `onStatus("connected")`, and `reconnect()` after
  sign-in when a 4401 close stopped it. Don't hand-roll a reconnect loop.
  Next.js can't accept upgrades: put a Node server in front (README recipe).
  `attachWs`/`connectWs`/`createWsSession`/`createWsClient` are low-level (no
  Origin check, limits or reconnect) — only for runtimes without `ws`.
- **Other runtimes:** `toFetchHandler` (Hono/Bun/Deno/Workers), `toNodeHandler`
  (`node:http`), `toRestHandler` (plain REST), `toOpenApiDocument` (3.1 spec).
- **Class controllers:** a class whose fields are procedures; put an *instance*
  in the router (`users: new UsersController(db)`). Keep injected deps in
  `#private` fields. A class-containing router can't use `satisfies RouterRecord`
  — the consumer functions accept `object` and `Client<AppRouter>` validates it.
- **Validation:** built-in `s.*` (`string/number/integer/boolean/literal/enum/
  union/null/nullable/array/record/object`, with chainable constraints like
  `s.string().min(1).max(200).email()`, `s.integer().min(1)`,
  `s.object({…}).strict()`), or any Standard Schema lib (Zod/Valibot/ArkType).
  Constraints are emitted into OpenAPI and AI tool schemas automatically, for
  `s.*`, Zod 4, ArkType, and Valibot wrapped in `toStandardJsonSchema`
  (`@valibot/to-json-schema`). `.ai()` throws on an input with no JSON Schema
  (Zod 3, plain Valibot, a Zod `z.date()`) — don't work around it.

## AI / MCP

```ts
import { toToolset, createToolExecutor, mcpToolDefinitions,
         toToolSource, mergeToolsets, createMcpToolSource } from "dendra";

const tools = toToolset(appRouter, { format: "anthropic" }); // or "openai"/"plain"
const execute = createToolExecutor(appRouter, ctx);          // validated, ctx-scoped
const mcp = mcpToolDefinitions(appRouter);                   // MCP tools/list

// Consume an EXTERNAL MCP server and blend it with local tools:
const local = toToolSource(appRouter, ctx, { format: "anthropic" });
const external = await createMcpToolSource(connectedMcpClient, { prefix: "gh." });
const merged = mergeToolsets(local, external);               // one { tools, execute }
```

Optional helpers (peer deps, opt-in; **experimental**, may change in a minor release):
- `dendra/anthropic` → `runAgent({ client, model, tools, execute, prompt, system })`
  runs the model↔tool loop and yields typed `AgentPart`s.
- `dendra/react` → `useAssistant({ stream, onPart, onDone })` owns the chat thread
  and streaming; you keep rendering.

**Context layer (opt-in, experimental).** `createContextManager({ budget, sources })` unifies
memory recall + lazy tool loading under one token budget; pass it as
`runAgent({ context })`. Sources: `memorySource(store, { recall, remember })` and
`lazyToolSource(tools, { pin, k })` (defers schemas behind `search_tools`). Core has
no tokenizer/embedder — you inject `budget.count`; the embedder lives in your
`MemoryStore`; import `createMemoryStore` from `dendra/memory`. Standalone `memory`/`lazyToolset`/`recall`/`remember` options on
`runAgent` still work when you don't use a manager.

## The framework ↔ app boundary (important)

> Would **every** dendra user want this regardless of their DB, auth, UI, or which
> servers they connect to? Yes → framework. No → app.

Put in the **app**, never inside framework calls: authentication, UI/navigation,
voice, and MCP *connection* management (transports, a connection registry, OAuth
to remote servers). dendra only provides the typed-procedure and tool-shaping
primitives. See [ARCHITECTURE.md](ARCHITECTURE.md) and the worked example in
[`examples/nextjs-app/`](examples/nextjs-app/).

## Don't

- Don't import `resolveProc`/`invokeUnary`/`invokeStream` from `dendra` — they're
  in `dendra/adapter` (experimental), for writing transports, not apps.
- Don't write codegen or `.d.ts` by hand — the client type comes from `typeof appRouter`.
- Don't add auth/session logic inside a handler's framework wiring — put it in `ctx`/`.use()`.
- Don't expose a procedure as a tool unless you add `.ai()`.
- Don't reach for `runAgent`/`useAssistant` if you already have a loop/UI — `mergeToolsets` is enough.
- Don't use names marked `@deprecated` — the tag names the replacement and the
  release that removes it. `@experimental` APIs may change in a minor release
  ([versioning policy](https://products.techfoundry.io/dendra/versioning)).
