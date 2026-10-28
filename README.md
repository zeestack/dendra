<div align="center">

<img src="https://raw.githubusercontent.com/zeestack/dendra/main/assets/dendra-banner.png" alt="dendra — one definition, many surfaces" width="620">

<br>

**The typed API framework where every procedure is also an LLM tool and an MCP server — with zero extra work.**

[![npm](https://img.shields.io/npm/v/dendra?color=7c9cff&label=npm)](https://www.npmjs.com/package/dendra)
[![downloads](https://img.shields.io/endpoint?url=https%3A%2F%2Fproducts.techfoundry.io%2Fdendra%2Fbadges%2Fnpm-downloads-30d.json)](https://www.npmjs.com/package/dendra)
[![CI](https://github.com/zeestack/dendra/actions/workflows/ci.yml/badge.svg)](https://github.com/zeestack/dendra/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-7c9cff.svg)](https://github.com/zeestack/dendra/blob/main/LICENSE)
[![runtime deps](https://img.shields.io/badge/runtime%20deps-0-5be3b3.svg)](https://github.com/zeestack/dendra/blob/main/package.json)
[![types](https://img.shields.io/badge/types-included-7c9cff.svg)](#)
[![no codegen](https://img.shields.io/badge/codegen-none-5be3b3.svg)](#)

[Quickstart](#quickstart) · [AI / MCP](#the-ai--mcp-story) · [Architecture](#architecture) · [Example app](#examples) · [Compare](#how-it-compares)

</div>

---

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

## Why another API framework?

The typed-RPC space is crowded (tRPC, ts-rest, Hono, oRPC) and they're all good at
HTTP. dendra's wedge is the part they bolt on or skip entirely: **AI- and
MCP-native by construction.** A procedure and an LLM tool are the same shape —
a name, an input schema, a validated handler — so dendra treats them as one
thing. Mark a procedure `.ai()` and it's instantly:

- an **MCP tool** (stdio for Claude Desktop, or remote HTTP for claude.ai), and
- a tool definition for the **Anthropic / OpenAI** APIs, executed with the same
  validation that guards your HTTP endpoints — so hallucinated arguments are
  rejected and the model inherits the *user's* permissions, not god mode.

Everything else — zero deps, no decorators, no codegen, runtime-agnostic — is
table stakes it also happens to get right.

## One definition → many surfaces

<div align="center">
<img src="https://raw.githubusercontent.com/zeestack/dendra/main/assets/arch-framework2.jpg" alt="dendra framework architecture: one definition branches into typed client, REST + OpenAPI, in-process caller, streaming, LLM tools, and an MCP server" width="820">
<br>
<sub><a href="https://products.techfoundry.io/dendra/architecture/framework.html">▶ open the interactive diagram</a></sub>
</div>

The router is used **twice from one definition**: as a *type* that flows to the
client (erased at build — zero runtime), and as a *value* the adapters dispatch
against.

## Quickstart

Scaffold a working Next.js app in one command:

```bash
npm create dendra-app@latest my-app      # pick: minimal | mcp
cd my-app && npm run dev
```

Or add it to an existing project:

```bash
npm i dendra
```

The core is zero-dependency. The optional helpers pull their own peers only if you
use them: `npm i @anthropic-ai/sdk` for `dendra/anthropic`, `react` for `dendra/react`,
`next` for `dendra/next`.

**Define** once:

```ts
import { initDendra, s, type RouterRecord } from "dendra";

interface Ctx { userId: string | null }
const { route } = initDendra<Ctx>();

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

**Serve** (Next.js App Router — `app/rpc/[...path]/route.ts`):

```ts
import { toNextHandler } from "dendra";
import { appRouter } from "@/server/router";

export const { GET, POST } = toNextHandler(appRouter, {
  createContext: (req) => ({ userId: getSession(req) }),
});
```

Other runtimes use the same router: `toFetchHandler` (Hono/Bun/Deno/Workers),
`toNodeHandler` (`node:http`).

**Call** — the client type comes straight from `typeof appRouter`, no generated files:

```ts
import { createClient } from "dendra";
import type { AppRouter } from "@/server/router";

const api = createClient<AppRouter>("");
const sum = await api.add({ a: 40, b: 2 });            // number, inferred
for await (const t of api.chat({ prompt: "hi" })) ...  // streaming, inferred
api.chat({ prompt: "hi" }, { signal });                // abort a call or a stream
```

Calls are real Promises (`.catch`, `.finally`, `Promise.race` all work) and stay
lazy: nothing is sent until you await or iterate one. Results are typed as what
survives JSON (`Jsonify<T>`): a handler returning a `Date` gives the client a
`string`, and `undefined` props come back optional.

In a Server Component, skip HTTP entirely with an in-process caller — no
serialization, so results keep their real types (a `Date` stays a `Date`; the
type is `Caller<AppRouter>`). `createServerCaller` from `dendra/next` builds
`ctx` from the incoming request with your route handler's `createContext`, once
per request however many layouts and pages ask; `orPage` turns errors into pages:

```ts
// server/caller.ts
import { createServerCaller } from "dendra/next";
export const serverCaller = createServerCaller(appRouter, createContext);

// app/notes/[id]/page.tsx
import { orPage } from "dendra/next";
const api = await serverCaller();
// NOT_FOUND / BAD_REQUEST → notFound(); UNAUTHORIZED → redirect("/sign-in")
const note = await orPage(api.notes.get({ id }), { signIn: "/sign-in" });
```

`createContext` gets a `Request` carrying the incoming headers (cookies too),
with the request's origin as its URL. Outside Next, `createCaller(appRouter, ctx)`
takes a `ctx` you build yourself.

## The AI / MCP story

```ts
import { toToolset, createToolExecutor, mcpToolDefinitions } from "dendra";

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

The [Next.js example](https://github.com/zeestack/dendra/tree/main/examples/nextjs-app) ships a working MCP server both ways:
a **stdio** server for Claude Desktop and a **remote HTTP** endpoint for claude.ai
(with optional OAuth 2.1) — so Claude can list, create, and delete your app's data
through the exact procedures you already wrote.

### Consuming external MCP servers (inbound tools)

The reverse direction too: pull tools **from** another MCP server (GitHub's,
Linear's, a filesystem server, your own) and merge them into the same toolset
your model already uses. dendra stays zero-dependency — it needs only the
two-method `McpClientLike` shape, which the official SDK's `Client` satisfies, so
*your app* owns the transport (stdio / HTTP) and dendra owns the tool plumbing.

```ts
import { toToolSource, mergeToolsets, createMcpToolSource } from "dendra";

const local = toToolSource(appRouter, ctx, { format: "anthropic" });
const external = await createMcpToolSource(mcpClient, {
  format: "anthropic",
  prefix: "gh.",            // optional: namespace to avoid name clashes
});

// One flat toolset; each call routes back to the source that owns the name.
const { tools, execute } = mergeToolsets(local, external);
```

### Optional helpers: the agentic loop + a React hook

Core stays zero-dependency, but two **optional subpath exports** remove the
boilerplate of a tool-using chat. They exchange one shared `AgentPart` type, so
they snap together — the loop emits parts, the hook renders them:

```ts
// server — dendra/anthropic (peer dep: @anthropic-ai/sdk)
import { runAgent } from "dendra/anthropic";
const { tools, execute } = mergeToolsets(toToolSource(appRouter, ctx), external);
yield* runAgent({ client, model, tools, execute, prompt, system });
```

```tsx
// client — dendra/react (peer dep: react)
import { useAssistant } from "dendra/react";
const { items, input, setInput, busy, send } = useAssistant({
  stream: (prompt) => api.ai.assistant({ prompt }),
  onPart: (p) => { /* act on a tool as it arrives */ },
  onDone: (parts, { spoken }) => { /* speak the reply */ },
});
```

Neither is required — bring your own loop/UI and just use `mergeToolsets`.

**Amazon Bedrock:** `runAgent`'s client type is structural, so Claude on Bedrock
drops in with no cast — pass an `AnthropicBedrock` client from
[`@anthropic-ai/bedrock-sdk`](https://www.npmjs.com/package/@anthropic-ai/bedrock-sdk):

```ts
import { AnthropicBedrock } from "@anthropic-ai/bedrock-sdk";
yield* runAgent({ client: new AnthropicBedrock({ awsRegion: "us-east-1" }),
  model: "anthropic.claude-3-5-sonnet-20241022-v2:0", tools, execute, prompt });
```

For non-Claude Bedrock models, use `toToolset(router, { format: "plain" })` and map
it to the Converse API's `toolSpec` (a `dendra/bedrock` helper is on the roadmap).

## Middleware & auth (`.use()`)

Run logic before a handler — authentication, logging, rate-limiting — and enrich
the context. One `.use()` runs across **every** transport (RPC, REST, the
in-process caller, WebSocket, and AI/MCP tool execution).

```ts
const authed = route.use(({ ctx }) => {
  if (!ctx.token) throw new DendraError("UNAUTHORIZED", "Sign in required");
  return { userId: lookup(ctx.token) };   // merged into ctx, typed downstream
});

export const appRouter = {
  me:     authed.handler(({ ctx }) => ctx.userId),          // ctx.userId is typed
  delete: authed.input(s.object({ id: s.string() }))
                .ai({ description: "Delete an item" })        // tool is auth-guarded too
                .handler(({ ctx, input }) => db.remove(ctx.userId, input.id)),
} satisfies RouterRecord;
```

Middlewares **stack** and **throw a `DendraError` to reject**. Because an AI/MCP
tool runs through the same dispatch path, a procedure behind `.use(auth)` is
authorization-guarded for the model too — it inherits the user's permissions, it
can't bypass them.

### Input a middleware needs (tenant guards)

A `.use()` sees the input declared **above** it, already validated. So a guard
declares the fields it checks once, and later `.input()` calls **extend** that
input rather than replacing it:

```ts
const inWorkspace = authed
  .input(s.object({ workspaceId: s.integer() }))
  .use(({ ctx, input }) => {                       // input: { workspaceId: number }
    if (!ctx.memberships.has(input.workspaceId)) throw new DendraError("FORBIDDEN", "Not a member");
    return { workspaceId: input.workspaceId };
  });

export const appRouter = {
  rename: inWorkspace
    .input(s.object({ title: s.string() }))        // input: { workspaceId; title }
    .handler(({ ctx, input }) => db.rename(ctx.workspaceId, input.title)),
} satisfies RouterRecord;
```

- Every schema in the chain validates the call, and all issues come back in one
  400. Chained schemas must produce objects; libraries can be mixed.
- If two schemas declare the same key, the **earlier** one wins, so the handler
  sees exactly the value the guard checked.
- OpenAPI and tool schemas show one combined object. Two built-in `s.object`s
  merge into one, so `.strict()` checks the combined keys. Other libraries don't
  publish a JSON schema today, so only `s.*` parts appear there — and don't make
  a non-`s.*` base schema strict, since it would reject the later fields.

### After-hooks (`.after()`) — audit, usage, metrics

`.use()` runs before the handler; `.after()` runs once the call **settles** and
sees the outcome. Same reach: every transport, including AI/MCP tool calls.

```ts
const audited = authed.after(({ ctx, path, transport, input, ok, result, code, durationMs }) =>
  ctx.db.audit.insert({ user: ctx.userId, path, transport, ok, code, durationMs }),
);
```

- `ok: true` carries `result` (undefined for streams, which settle when they end);
  `ok: false` carries the thrown `error` and its `code` (`"INTERNAL"` for
  non-`DendraError`s). `transport` is `"rpc" | "rest" | "caller" | "ws" | "tool"`.
- Hooks are **awaited** before the response goes out (safe on serverless), run
  in the order added, and a hook that throws is logged — it never changes the result.
- **Position matters:** a hook only runs for calls that passed the `.use()`s
  before it, and sees that ctx — so `ctx.userId` above is typed and real. Put a
  hook *before* the auth guard to also record rejected calls. Input that fails
  validation never reaches the chain, so it doesn't trigger hooks.

### Checking guards in a test (`inspectRouter`)

Name a middleware (or let it use its function's name), tag procedures with
typed `.meta()`, then walk the router and fail the build when a guard is missing:

```ts
const { route } = initDendra<Ctx, { restricted?: "approver" }>();

const scoped = route.use(tenant);                       // listed as "tenant"
const publish = scoped
  .use(requireRole("approver"), { name: "role:approver" })
  .meta({ restricted: "approver" })
  .handler(/* … */);

// test/guards.test.ts
for (const p of inspectRouter<{ restricted?: "approver" }>(appRouter)) {
  expect(p.middlewares, p.path).toContain("tenant");
  if (p.meta.restricted) {
    expect(p.middlewares, p.path).toContain(`role:${p.meta.restricted}`);
    expect(p.ai, p.path).toBe(false);
  }
}
```

Each entry is `{ path, kind, method, restPath?, middlewares, ai, meta }`, class
controllers included. An unnamed inline middleware is listed as `"anonymous"`;
`.meta()` calls merge, and only `inspectRouter` reads them.

## Files in and out

A file route is just a procedure, so the tenant check in `.use()` and the audit
trail in `.after()` cover it like any other call.

```ts
import { file, s } from "dendra";

export const covers = {
  upload: tenant
    .input(s.object({
      workspaceId: s.integer(),
      image: s.file({ types: ["image/png", "image/jpeg", "image/webp"], maxBytes: 8_000_000 }),
    }))
    .handler(({ input, ctx }) => ctx.storage.put(input.workspaceId, input.image)), // input.image: File

  get: tenant
    .get()                                  // a read: reachable by GET / urlFor
    .input(s.object({ workspaceId: s.integer(), draftId: s.integer() }))
    .handler(async ({ input, ctx }) => {
      const obj = await ctx.storage.get(input.draftId);
      return file(obj.stream, { type: obj.type, filename: "cover.webp", inline: true,
                                cacheControl: "private, max-age=300", etag: obj.hash });
    }),
};
```

```tsx
await api.covers.upload({ workspaceId: 3, image: fileFromInput }); // sent as multipart
const blob = await api.drafts.exportMarkdown({ draftId: 9 });       // Blob
<img src={urlFor(api.covers.get, { workspaceId: 3, draftId: 9 })} />
```

- **Uploads:** `s.file({ types, maxBytes })` sits in an ordinary `s.object`.
  PNG, JPEG, GIF, WebP, PDF and ZIP are checked against the file's leading bytes,
  not just the browser's header; other types match by MIME type or extension
  (`".csv"`). Request bodies are capped by `maxBodyBytes` (default 10 MB),
  enforced while reading → `413 PAYLOAD_TOO_LARGE`. Files live at the top level
  of the input and go direct (never batched). A file-input procedure can't be `.ai()`.
- **Downloads:** return `file(body, opts)`. Every file response carries
  `X-Content-Type-Options: nosniff`; the filename is sanitized; `Cache-Control`
  defaults to `private, no-store`; `etag` enables `304`. HTML, SVG and XML are
  always sent as attachments unless you set `allowUnsafeInline` — an uploaded
  file must never run script on your origin. Tool, batch and WebSocket calls
  can't return files.
- **`urlFor` needs `.get()`.** Only procedures declared `.get()` (path optional)
  answer GET, and `urlFor` won't type-check for anything else — so a link or
  `<img>` on another site can never trigger a mutation.
- **Audit hooks see metadata, never bytes:** for a file result, `.after()` gets
  `{ file: { type, filename, size } }`. Log `input.image.name/type/size`, not the File.

### CSRF

dendra's client sends `X-Dendra: 1` on every request. Because a cross-site page
can't send a custom header (or a JSON body) without a CORS preflight, the server
requires: **GET/HEAD** only for `.get()` reads, other methods besides POST
never (`405`); **POST** as JSON (else `415`), or multipart carrying `X-Dendra`
(else `403`). Plain HTML form posts are
off unless you pass `allowFormPosts: true` — then CSRF protection is your job
(e.g. a token checked in `.use()`). This assumes you don't enable
CORS-with-credentials for untrusted origins.

**WebSockets are the exception:** browsers apply no CORS to them, and any site
can open one to your server with the user's cookies. Serve them with
`attachWsServer`, which requires `allowedOrigins` and refuses a foreign or
missing `Origin` with 403 before the socket opens. If you use the lower-level
`attachWs` on a socket you accepted yourself, that check is yours.

### WebSockets with Next.js

Next.js route handlers can't accept WebSocket upgrades, so run one small Node
server in front of Next. Next attaches its own `upgrade` listener on the first
request (that's how dev hot reload works), and it closes any upgrade whose path
matches one of your routes. So give the socket a path **outside** your Next
routes (`/ws`, not under an `app/rpc/[...path]` handler), and leave other
upgrades to Next's own listener:

```ts
// server.ts — run with `node server.ts` instead of `next start`
import http from "node:http";
import next from "next";
import { WebSocketServer } from "ws";
import { attachWsServer, DendraError } from "dendra";
import { appRouter } from "./server/router";

const app = next({ dev: process.env.NODE_ENV !== "production" });
await app.prepare();
const handle = app.getRequestHandler();

const wss = new WebSocketServer({ noServer: true, maxPayload: 1_000_000 });
const live = attachWsServer(wss, appRouter, {
  path: "/ws", // outside every Next route
  allowedOrigins: ["https://app.example.com"],
  createContext: async (req) => {
    const user = await getSession(req.headers);
    if (!user) throw new DendraError("UNAUTHORIZED", "Sign in required");
    return { user };
  },
  revalidate: { everyMs: 5 * 60_000, check: (ctx) => sessionStillValid(ctx.user) },
  onClose: (ctx) => presence.leave(ctx.user.id),
});

const server = http.createServer((req, res) => handle(req, res));
// Other paths return false and are left to Next's own upgrade listener.
server.on("upgrade", (req, socket, head) => live.handleUpgrade(req, socket, head));
server.listen(3000);

process.on("SIGTERM", async () => {
  await live.close(); // refuse new sockets (503), close open ones with 1001
  server.close();
});
```

Sign someone out everywhere with `live.closeWhere((ctx) => ctx.user.id === id)`.

In the browser, `createWsConnection` keeps the socket up: it reconnects with
backoff (0.5 s doubling to 10 s, with jitter), retries as soon as the browser is
back online, and resubscribes open subscriptions, so a `for await` loop survives a
dropped connection. Anything published while it was down is missed, so refetch
when the status turns `connected` again.

```ts
import { createWsConnection } from "dendra";
import type { AppRouter } from "@/server/router";

const conn = createWsConnection<AppRouter>(`wss://${location.host}/ws`);
conn.onStatus((status) => setBanner(status)); // connecting | connected | reconnecting | stopped | closed
for await (const ev of conn.api.notes.watch()) render(ev);
```

A close with code `4401` (signed out) stops it with status `stopped`; call
`conn.reconnect()` after signing in again. Calls made while disconnected fail at
once with code `UNAVAILABLE` rather than being replayed later.

| Option | Default | |
|---|---|---|
| `maxPayload` | 1 MB | Startup throws if the `ws` server allows more |
| `heartbeatMs` | 30 s | A socket that misses a pong is dropped (`0` disables) |
| `maxBufferedBytes` | 1 MB | Unsent backlog before a slow client is closed |
| `maxSubscriptions` | 100 | Per connection; more get `TOO_MANY_REQUESTS` |
| `closeGraceMs` | 1 s | Wait for the close handshake, then terminate |
| `allowMissingOrigin` | `false` | Only for non-browser clients without cookie auth |

| Close code | Meaning |
|---|---|
| `1001` | Server shutting down (`close()`) |
| `1009` | Message over `maxPayload` |
| `1013` | Client too slow to read |
| `4401` | `revalidate` said no, or `closeWhere` (default) — sign in again |

## Background jobs

Long work (an AI call, an export) shouldn't hang off a request or vanish in a
deploy. Define a **job**, enqueue it from a procedure, and stream its status:

```ts
import { createJobs, createPgJobStore } from "dendra";

const store = createPgJobStore(pool);     // or createInMemoryJobStore() in dev
export const jobs = createJobs({
  store,
  pubsub,                                 // status events go out here
  context: () => ({ db }),                // the ctx jobs run with — never the request's
});

export const summarize = jobs.define("summarize", {
  input: s.object({ docId: s.string(), workspaceId: s.integer() }),
  key: (input) => input.docId,            // one queued-or-running job per doc
  retries: 3,                             // backoff 1 s, 2 s, 4 s … (capped at 60 s)
  concurrency: 2,                         // per process
  run: async ({ input, ctx, job }) => {
    await job.progress({ step: "reading" });
    return ctx.db.summaries.create(input, { signal: job.signal });
  },
});

jobs.start(); // in each process that should run jobs (await jobs.stop() on shutdown)

const appRouter = {
  summarize: inWorkspace                  // the guard from the section above
    .input(s.object({ docId: s.string() }))
    .background(summarize, ({ input, ctx }) => ({ docId: input.docId, workspaceId: ctx.workspaceId })),
  // → { jobId }, right away, after validation and the guards.

  job: inWorkspace
    .input(s.object({ jobId: s.string() }))
    .use(async ({ input, ctx }) => {
      const job = await store.get(input.jobId); // the full record, input included
      if ((job?.input as { workspaceId?: number })?.workspaceId !== ctx.workspaceId)
        throw new DendraError("NOT_FOUND", "No such job");
    })
    .stream(({ input, signal }) => summarize.watch(input.jobId, { signal })),
  // → the job's state now, then each change, ending at "succeeded" or "failed".
};
```

- **Named, not path-bound.** A queued job finds its handler by name, so renaming a
  route doesn't orphan it.
- **Own ctx.** After a crash another process runs the job, so it gets `context()`,
  not the request's ctx. Pass what it needs (workspace, user id) through `map`.
- **`watch` shows each state once, in order.** Every snapshot carries a
  `version` that goes up with each change, so a client can also drop stale ones.
- **`watch` doesn't check access.** Job ids are random UUIDs, but guard the
  procedure anyway, as above: `store.get(id)` returns the job's input to check.
- **Survives crashes.** A worker holds a lease on a running job and renews it.
  By default, an expired lease allows retry, and `stop()` aborts `job.signal`
  and requeues running jobs without using an attempt. Set `onInterrupt: "fail"`
  for work that must not replay after a crash, shutdown or execution deadline.
- **Snapshots:** `{ id, name, status, attempt, maxAttempts, progress, result, error }`,
  where `status` is `"queued" | "running" | "succeeded" | "failed"` and `error` is
  `{ code, message }`. A retrying job is `"queued"` with the last error.
- **Postgres store:** `await store.setup()` creates `dendra_jobs` (or copy
  `store.schema` into a migration). Workers claim with `FOR UPDATE SKIP LOCKED`,
  so any number of processes share the queue. Finished rows stay until you
  delete them.

### Execution deadlines and shutdown

Use explicit policies for work that charges an external provider:

```ts
const generate = jobs.define("generate-v2", {
  retries: 0,
  timeoutMs: 20 * 60_000,
  onInterrupt: "fail",
  concurrency: 2,
  run: ({ input, job }) => generateImage(input, { signal: job.signal }),
});

const stopped = await jobs.stop({ graceMs: 6_000, timeoutMs: 8_000 });
if (!stopped.drained) console.error("Unfinished jobs", stopped.pending, stopped.errors);
```

The deadline is persisted when an attempt is claimed. Late progress and results
cannot overwrite its terminal outcome. A handler that ignores cancellation keeps
its local concurrency slot until it actually exits. JavaScript cannot cancel a
provider's completed charge or guarantee exactly-once external side effects;
use provider idempotency keys where available. `onInterrupt: "fail"` prevents
automatic replay of an interrupted job; ordinary error retries still follow
`retries`.

`stop({ graceMs, timeoutMs })` stops taking work, allows the grace period, aborts
remaining handlers and waits only within the total budget. Its result reports
unfinished work or failed settlement instead of claiming a successful drain.
The no-argument `stop()` keeps immediate cancellation and its `Promise<void>`
signature, but rejects if work does not drain within 30 seconds.

Apply the updated `store.schema` as the database owner before deploying workers;
it adds policy columns to existing tables. Stop old workers before enabling new
policies, since 0.9 workers do not understand them. Custom stores must advertise
and implement `capabilities.executionPolicies` to accept these options.

### Durable daily and weekly schedules

```ts
await sync.schedule("daily-search-sync", { workspaceId: 13 },
  { kind: "daily", hourUTC: 2, minuteUTC: 0 });
await rankCheck.schedule("weekly-rank-check", { workspaceId: 13 },
  { kind: "weekly", weekdayUTC: 1, hourUTC: 3, minuteUTC: 0 });
await jobs.unschedule("weekly-rank-check");
```

Schedules use UTC; weekdays run from Sunday (`0`) through Saturday (`6`). Input
is validated using the job's schema. Re-registering an unchanged schedule keeps
its next occurrence. Updating or removing a schedule invalidates stale scheduler
reads. Removing a schedule does not cancel work already enqueued.

Workers atomically enqueue each occurrence and advance its cursor, so concurrent
workers cannot create duplicate occurrences. Missed occurrences coalesce into
one catch-up job, followed by the next future occurrence; a restart does not
replay the entire backlog. Existing active-key deduplication still applies.
Arbitrary cron expressions and local-time/DST scheduling are not supported.

The Postgres schema adds a companion schedules table and revision sequence.
After owner-run migration, grant the runtime role table DML and sequence USAGE.
Custom stores need `capabilities.schedules` and the `JobScheduleStore` methods.

## Class-based controllers (NestJS-style, no decorators)

Prefer classes for grouping and dependency injection? A controller is just a
class whose **fields are procedures** — put an *instance* in the router. NestJS
structure and constructor DI without decorators, `reflect-metadata`, or
`experimentalDecorators`.

```ts
export class UsersController {
  #db: Db;                                        // #private: not part of the
  constructor(db: Db) { this.#db = db; }          // public (procedures-only) type

  list = route.get("/users").handler(() => this.#db.users.all());
  create = route
    .post("/users")
    .input(s.object({ name: s.string() }))
    .ai({ description: "Create a user" })         // still an LLM/MCP tool
    .handler(({ input }) => this.#db.users.insert(input));
}

export const appRouter = {
  users: new UsersController(db),                 // an instance = a sub-router
};
```

| NestJS | dendra |
|---|---|
| `@Controller()` class | plain class with procedure fields |
| `@Get()` / `@Post()` decorators | `.get()` / `.post()` on the builder |
| `@Injectable()` + DI container | constructor injection (`new Ctrl(deps)`) |
| `@Module()` | compose the router object |
| decorators / `reflect-metadata` | none |

## How it compares

| | tRPC | ts-rest | Hono | **dendra** |
|---|---|---|---|---|
| Typed client, no codegen | ✅ | — | ✅ | ✅ |
| REST URLs + OpenAPI | plugin | ✅ | plugin | ✅ |
| Streaming | links | — | ✅ | ✅ |
| Real-time / WebSocket | subs | — | ✅ | ✅ |
| **LLM tools from procedures** | — | — | — | ✅ |
| **MCP server (stdio + HTTP)** | — | — | — | ✅ |
| **Consume external MCP servers** | — | — | — | ✅ |
| Decorators / codegen | none | none | none | **none** |
| Runtime deps | few | few | 0 | **0** |

Not trying to out-tRPC tRPC on HTTP — winning on the AI/MCP seam.

### dendra vs tRPC + MCP

tRPC is excellent — for a plain typed HTTP API, use it. The difference shows up
when you want your API callable by an LLM or Claude over MCP: with tRPC you bolt on
a parallel tool layer and keep it in sync by hand; with dendra the same definition
*is* the tool.

```ts
// tRPC + MCP: define once, then hand-build a separate tool layer…
const caller = appRouter.createCaller(ctx);
server.setRequestHandler(ListTools, async () => ({
  tools: [{ name: "createNote", description: "…",
    inputSchema: zodToJsonSchema(CreateNoteInput) }],   // keep in sync by hand
}));
server.setRequestHandler(CallTool, async (r) =>
  wrap(await caller[r.params.name](r.params.arguments)));  // route + re-validate yourself
// …repeat the schema→format work per provider; consuming other MCP servers is DIY.

// dendra: one definition is the tool.
createNote: route
  .input(s.object({ title: s.string(), body: s.string() }))
  .ai({ description: "Create a note" })     // ← becomes an LLM + MCP tool
  .handler(({ input, ctx }) => ctx.db.create(input));
```

| Making your API usable by an LLM / Claude | tRPC + MCP | **dendra** |
|---|---|---|
| Tool JSON Schema | hand-convert from Zod | same schema, automatic |
| Which procedures are tools | maintain a separate list | `.ai()` on the procedure |
| Validation + auth on tool calls | re-wire yourself | same path as HTTP |
| Anthropic + OpenAI formats | convert per provider | one `format` option |
| MCP server (stdio + HTTP) | write with the SDK | built-in bridge |
| Consume external MCP servers | DIY client + merge | `createMcpToolSource` + `mergeToolsets` |
| Drift risk | high — two sources of truth | none — one definition |

**Choose tRPC** for the largest ecosystem, its React Query integration, or an
existing tRPC codebase. **Choose dendra** when your API should be callable by
agents with no parallel tool layer, kept to one source of truth, and able to both
*expose* and *consume* MCP. Full side-by-side on the
[site](https://products.techfoundry.io/dendra/#vs).

## Also in the box

- **REST + OpenAPI** — give a procedure `.get("/users/:id")` and `.output(schema)`
  (type-checks the handler's return *and* documents the response); `toRestHandler`
  serves it, `toOpenApiDocument` emits a 3.1 spec (file uploads as multipart).
  `.get()` with no path marks an RPC read — the only procedures that answer GET.
- **Files** — `s.file()` uploads, `file()` downloads, `urlFor()` for `<img src>`;
  see [Files in and out](#files-in-and-out).
- **Background jobs** — `jobs.define()` + `.background()` → `{ jobId }`, with
  retries, a per-key lock, and status over the pub/sub; see
  [Background jobs](#background-jobs).
- **Real-time** — a subscription is a streaming procedure fed by a `PubSub`
  interface: `createInMemoryPubSub()` for dev, `createRedisPubSub(client)` or
  `createPgPubSub(pool)` (Postgres LISTEN/NOTIFY, see below) for multi-instance
  fan-out. Another broker (NATS, …) is a `createPubSub({ publish, subscribe,
  unsubscribe })` transport away. Stream handlers get a `signal` that aborts when the
  client goes away (disconnect, cancel, unsubscribe) — pass it to
  `subscribe(topic, { signal })`.
- **Postgres pub/sub** — `createPgPubSub(new pg.Pool(…))` holds one LISTEN
  connection per process (reconnecting with backoff) and sends every message as
  `{ topic, message }` JSON on one channel (`"dendra"` by default), so a trigger
  can publish too:
  `pg_notify('dendra', json_build_object('topic', 'notes', 'message', row_to_json(NEW))::text)`.
  NOTIFY payloads must be under 8000 bytes — publish an id, not the row, when it
  can be large; `publish` throws on oversize messages before sending.
- **External MCP tools** — `createMcpToolSource(client)` + `mergeToolsets(...)`
  blend remote tools into your agent loop.
- **WebSocket** — `attachWsServer` accepts sockets with an Origin check, a
  per-connection context and resource limits; `createWsConnection` keeps the
  browser side connected and resubscribes; calls and subscriptions share one
  socket, same router.
- **Request batching** — `createClient(url, { batch: true })` collects unary calls
  made in the same tick into one HTTP round-trip (`__batch?p=a,b`, so logs and
  mocks see the names). Results stream back as each call settles, so a slow call
  never holds up a quick one; `{ batch: false }` sends a call alone, and
  streaming stays direct.
- **Standard Schema** — Zod (3 and 4), Valibot, ArkType — each type-checked in
  the test suite — or the built-in `s.*` validators:
  `string/number/integer/boolean/literal/enum/union/null/nullable/array/record/object/file`,
  with fluent constraints (`s.string().min(1).max(200).email()`,
  `s.integer().min(1)`, `s.object({…}).strict()`). Constraints flow straight into
  OpenAPI **and** AI tool schemas, so the model sees enums, bounds, and formats.

## Architecture

[`ARCHITECTURE.md`](https://github.com/zeestack/dendra/blob/main/ARCHITECTURE.md) explains the split between the **framework**
(`dendra`, in `src/`) and the **app** (the Next.js example) — and why auth,
navigation, voice, and MCP connection/OAuth management are app concerns while only
the typed-procedure and tool-shaping primitives live in the framework.

## For AI coding agents

Building an app *with* dendra? Two aids ship in the repo:

- [`AGENTS.md`](https://github.com/zeestack/dendra/blob/main/AGENTS.md) — a compact cheat sheet (install, the define→serve→call
  pattern, conventions, and the framework-vs-app rule) that any coding agent can read.
- A packaged skill at [`.claude/skills/dendra/`](https://github.com/zeestack/dendra/blob/main/.claude/skills/dendra/SKILL.md) —
  available automatically when this repo is opened in Claude Code; it teaches an
  agent to scaffold and extend a dendra app idiomatically.

(Consuming a running dendra app's tools *at runtime* needs no skill — that's just
MCP; point any MCP client at its `/api/mcp` or stdio server.)

## Examples

<div align="center">
<img src="https://raw.githubusercontent.com/zeestack/dendra/main/assets/arch-example.png" alt="dendra example app architecture: browser and Claude talk to Next.js routes and the appRouter, which uses SQLite, pub/sub, runAgent, and an MCP connection registry with OAuth" width="820">
<br>
<sub><a href="https://products.techfoundry.io/dendra/architecture/example.html">▶ open the interactive diagram</a></sub>
</div>

- [`examples/demo.ts`](https://github.com/zeestack/dendra/blob/main/examples/demo.ts) — caller, unary, validation, streaming, AI tools, pub/sub.
- [`examples/rest-ws-demo.ts`](https://github.com/zeestack/dendra/blob/main/examples/rest-ws-demo.ts) — REST, OpenAPI, WebSocket transport.
- [`examples/nextjs-app/`](https://github.com/zeestack/dendra/tree/main/examples/nextjs-app) — full Next.js app: RPC + REST,
  Server Components, generative-UI chat with voice, real LLM, subdomain
  multi-tenancy, resilient real-time notes, a NestJS-style class controller, MCP
  both ways (serve to Claude **and** connect out to external MCP servers with
  OAuth 2.1).

## Develop

```bash
npm install
npm run build      # tsup → ESM + CJS + .d.ts in dist/ (core + /anthropic + /react)
npm test           # vitest: runtime + type-level inference tests
npm run demo       # boots a server + typed client, exercises everything
npm run demo:restws
```

**Releasing** is automated: bump the version and push the tag, and CI publishes to
npm (with provenance) via [`.github/workflows/publish.yml`](https://github.com/zeestack/dendra/blob/main/.github/workflows/publish.yml)
— requires an `NPM_TOKEN` repo secret.

```bash
npm version patch   # or minor / major — bumps package.json and tags
git push --follow-tags
```

## Status

**Pre-1.0 (v0.9.0) — experimental, but broad.** Implemented and tested
(over 260 tests, runtime + type-level, plus Postgres integration tests in CI): builder/router/dispatch, a batteries-included
Standard Schema validator set (literals, enums, unions, nullable, record, and
fluent string/number/array constraints), Next/Fetch/Node adapters, REST +
OpenAPI, inferred client (unary + streaming), NDJSON streaming with cancellation,
WebSocket transport, middleware (`.use()`), typed `.output()`, request batching,
in-memory, Redis **and** Postgres pub/sub, class controllers, AI tools, MCP (stdio + remote
HTTP, consume external MCP servers), a unified **context layer**
(`createContextManager` — memory recall + lazy tool loading under one token
budget), and optional `dendra/anthropic` + `dendra/react` helpers. Also after-hooks
(`.after()`), files in and out (`s.file()`, `file()`, `urlFor`), background jobs,
and a WebSocket server and browser connection with safe defaults.

> **Breaking in 0.9.0 (types, and chained `.input()`):** client results are typed
> as what survives JSON (a `Date` is a `string`; `createCaller` keeps real types as
> `Caller<R>`), and a second `.input()` extends the first instead of replacing it.
> See the [release notes](https://products.techfoundry.io/dendra/releases).

Published on npm as [`dendra`](https://www.npmjs.com/package/dendra). Docs:
[products.techfoundry.io/dendra](https://products.techfoundry.io/dendra/) —
what changed in each version is in the
[release notes](https://products.techfoundry.io/dendra/releases/). APIs may
change before 1.0. What's planned next is in [`ROADMAP.md`](https://github.com/zeestack/dendra/blob/main/ROADMAP.md).

## License

MIT
