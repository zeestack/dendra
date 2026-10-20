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
npm i next                # for dendra/next (orPage)
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

In a Server Component, skip HTTP with `createCaller(appRouter, ctx)`, and wrap
calls in `orPage(call, { signIn })` from `dendra/next` so NOT_FOUND/BAD_REQUEST
become `notFound()` and UNAUTHORIZED a sign-in redirect.

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
- **Client results are JSON-typed.** `createClient` results are `Jsonify<Out>`
  (a `Date` arrives as a `string`); `createCaller` keeps real types
  (`Caller<R>`). Don't cast client results back to `Date` — parse them.
- **Streams stop with their consumer.** A `.stream()` handler gets `signal`,
  aborted when the client disconnects, cancels, unsubscribes, or aborts its own
  `{ signal }`. Pass it to `pubsub.subscribe(topic, { signal })` or long work
  won't stop. Batched calls (`batch: true`) stream back as each settles.
- **`.ai()` is opt-in.** Only `.ai()`-marked procedures are exposed as tools.
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
  Constraints are emitted into OpenAPI and AI tool schemas automatically.

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

Optional helpers (peer deps, opt-in):
- `dendra/anthropic` → `runAgent({ client, model, tools, execute, prompt, system })`
  runs the model↔tool loop and yields typed `AgentPart`s.
- `dendra/react` → `useAssistant({ stream, onPart, onDone })` owns the chat thread
  and streaming; you keep rendering.

**Context layer (opt-in).** `createContextManager({ budget, sources })` unifies
memory recall + lazy tool loading under one token budget; pass it as
`runAgent({ context })`. Sources: `memorySource(store, { recall, remember })` and
`toolSource(tools, { pin, k })` (defers schemas behind `search_tools`). Core has
no tokenizer/embedder — you inject `budget.count`; the embedder lives in your
`MemoryStore`. Standalone `memory`/`lazyToolset`/`recall`/`remember` options on
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

- Don't write codegen or `.d.ts` by hand — the client type comes from `typeof appRouter`.
- Don't add auth/session logic inside a handler's framework wiring — put it in `ctx`/`.use()`.
- Don't expose a procedure as a tool unless you add `.ai()`.
- Don't reach for `runAgent`/`useAssistant` if you already have a loop/UI — `mergeToolsets` is enough.
