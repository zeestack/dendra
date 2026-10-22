# Roadmap

dendra is pre-1.0 and experimental. This roadmap is a direction, not a promise —
scope and order will shift with feedback. Open an issue or discussion to weigh in.

**Guiding principle:** don't try to out-tRPC tRPC on plain HTTP. Win on the
**AI/MCP seam** (one definition is also an LLM tool and an MCP server, both
directions) and on **ease of adoption**. Keep the core zero-dependency; new
integrations ship as optional subpath exports with their own peer deps.

**Positioning:** dendra is an **API framework** ("tRPC for the AI era"), not a
model SDK. It complements model SDKs like the Vercel AI SDK rather than competing
with them — and it runs *on* platforms like Vercel/Next.js, not against them.
dendra owns "what your API is and how it becomes tools/MCP"; a model SDK owns "how
you call the model." The AI helpers (`dendra/anthropic`, `dendra/react`) are
optional convenience, not the moat.

---

## Shipped — 0.1.0

- Builder / router / dispatch; Standard Schema validation (`s.*`, Zod, Valibot, ArkType).
- Adapters: `toNextHandler`, `toFetchHandler`, `toNodeHandler`, `toRestHandler`.
- Typed client with no codegen; in-process `createCaller`.
- REST + OpenAPI 3.1; NDJSON streaming with cancellation; WebSocket transport.
- Middleware (`.use()`), typed `.output()`, request batching, class controllers.
- In-memory **and** Redis pub/sub.
- AI/MCP: `toToolset`, `createToolExecutor`, `mcpToolDefinitions`, `createMcpBridge`;
  consume external MCP servers via `createMcpToolSource` + `mergeToolsets`.
- Optional helpers: `dendra/anthropic` (`runAgent`), `dendra/react` (`useAssistant`).
- Published to npm as [`dendra`](https://www.npmjs.com/package/dendra); CI, tag-triggered
  publish, docs site, `ARCHITECTURE.md`, `AGENTS.md`, and a packaged skill.

---

## Shipped — 0.4.0 – 0.7.0

- **0.4.0** — batteries-included `s.*`: `literal`, `enum`, `union`, `null`,
  `nullable`, `integer`, `record`; chainable constraints (`.min/.max/.email/.uuid/
  .url/.pattern`, `object().strict()`) emitted into OpenAPI and AI tool schemas;
  `CONFLICT`, `UNPROCESSABLE`, `TOO_MANY_REQUESTS`, `NOT_IMPLEMENTED` error codes.
- **0.5.0** — `createContextManager`: memory recall and lazy tool loading under one
  token budget (see the context layer below).
- **0.6.0** — `.after()` hooks: see the outcome of every call (result or error
  code, duration, path, transport, ctx) on every transport — the primitive for
  audit trails and usage recording. _First of the Question Tool requests._
- **0.7.0** — files in and out: `s.file()` (byte-checked types, streamed size
  cap), `file()` downloads (nosniff, safe filenames, no inline HTML/SVG,
  ETag/304), `urlFor()`. Security: GET only reaches `.get()` reads and POST must
  be JSON — closing two CSRF holes in the RPC handler.
  Fixes: Zod 3/4, Valibot and ArkType schemas now type-check as `.input()`
  (Standard Schema path segments may be `{ key }`), checked by tests.

---

## Next — core first (0.8 → 0.10)

**Why this order.** Adopting dendra in a real product (question-tool: multi-tenant Next.js, Postgres, long AI
jobs) showed the core every app touches has gaps that hurt today, while most planned work is AI surface. So:
fix the core, then long-running work, then Next.js polish, then the AI items below in their current order.
Each item links the issue with the evidence.

### 0.8 — "core you can trust"
- [ ] ⭐ **Unary calls return real Promises** ([#4](https://github.com/zeestack/dendra/issues/4)) — today a thenable
  without `.catch` / `.finally`; apps wrap every call in `Promise.resolve(...)`.
- [ ] ⭐ **Typed, validated input in middleware** ([#2](https://github.com/zeestack/dendra/issues/2)) — a builder's
  `.input()` merges into every procedure, and `.use()` sees it typed; no more re-parsing raw input in guards.
- [ ] ⭐ **Streams end cleanly** ([#5](https://github.com/zeestack/dendra/issues/5)) — `signal` on client calls;
  `ReadableStream.cancel()` stops the server generator; `signal` passed to `.stream()` handlers.
- [ ] **Batching that doesn't stall** ([#9](https://github.com/zeestack/dendra/issues/9)) — stream batch results as
  each call settles, per-procedure opt-out (or batch only `.get()` reads by default), procedure names in the URL.
- [ ] **Honest client result types** ([#3](https://github.com/zeestack/dendra/issues/3)) — `Jsonify<Out>` so types
  match what JSON delivers; the serializer (candidates below) can follow.

### 0.9 — "long-running work"
- [x] ⭐ **Postgres pub/sub** ([#6](https://github.com/zeestack/dendra/issues/6)) — promoted from Field requests.
  question-tool's `src/lib/pg-pubsub.ts` (one LISTEN connection per process, reconnect, `{ topic, message }`
  on one channel, triggers can publish) is a tested starting point.
- [x] ⭐ **Background jobs** ([#7](https://github.com/zeestack/dendra/issues/7)) — promoted from Field requests:
  `.background()` → `{ jobId }`, retries with backoff, one running job per key, a concurrency cap per job name,
  status published on the pub/sub; in-process and Postgres stores.
- [ ] **Job status on the client** — a hook that follows a job over the subscription instead of polling
  (folds in `useProcedure` / `dendra/react-query`).
- [ ] **`inspectRouter`** — moved up from Field requests: fail the build when a procedure lacks its tenant or role check.
- [ ] **Safe-by-default AI** _(scheduled for 0.9, see Next)_ — moved up from Field requests (`.noAi()`, `.ai({ confirm: true })`): a security item.

### 0.10 — "Next.js first-class"
- [ ] **`dendra/next`** ([#8](https://github.com/zeestack/dendra/issues/8)) — `createServerCaller` reading
  `headers()`, and `orPage` (`NOT_FOUND` → `notFound()`, `UNAUTHORIZED` → sign-in redirect).
- [ ] **SSE subscriptions** — moved up from candidates, as an option beside NDJSON (friendlier to proxies).
- [ ] **"Deploying streams" recipe** — proxy flushing (Caddy `flush_interval -1`, nginx `proxy_buffering off`),
  compression, idle timeouts, heartbeats.

### Then
The AI / MCP work in the 0.2.0 section below, in its current order (skills, `dendra/openai`, `dendra/bedrock`,
MCP annotations, resources & prompts). Benchmarks after 0.8; the `full` app template after 0.9, so it can show
jobs and live status.

---

## 0.2.0 — "adoptable, and deeper on the wedge"

The focused set (the four that move the needle) is marked ⭐.

### Lower the barrier to entry
- [x] ⭐ **`create-dendra-app`** — `npm create dendra-app@latest my-app` scaffolds a
  working Next.js + dendra app. _Shipped: `minimal` + `mcp` templates, CI scaffold
  smoke test, published to npm._
- [ ] ⭐ **`dendra/react-query`** — typed TanStack Query hooks (`useQuery` /
  `useMutation`) over the router. Closes the biggest tRPC parity gap. Optional peer dep.
- [ ] ⭐ **Benchmarks** vs tRPC / Hono (throughput, cold start, bundle size) — a
  credible performance story.
- [x] **Package-page docs** (shipped 0.7.0) — absolute image and link URLs in
  the README so the npm and GitHub Packages pages render the diagrams and links.

### `dendra/context` — unified context management ⭐ (the spine)

The differentiator. Memory, tools, skills, and chat history are the **same
two-tier shape**: a compact descriptor always in context, full content loaded on
demand, everything drawn from **one token budget**, stale content evicted when it
tightens. Rather than ship these as four unrelated features, dendra unifies them
behind a single `ContextSource` primitive and a `createContextManager` that drives
the progressive-disclosure loop inside `runAgent`. See
[`design/context-management.md`](design/context-management.md) for the interface.

> tRPC gives you typed APIs. MCP gives you tools. **dendra gives you typed APIs
> that are also tools — and manages the model's context as one budgeted,
> progressively-disclosed layer.** Neither tRPC nor raw MCP can say that.

- [x] **Source #1 — `dendra/memory`** (shipped 0.2.0). `MemoryStore` interface +
  zero-dep reference store (swap in pgvector/SQLite/Redis with no call-site
  changes), model-agnostic `recallMemory` / `rememberFacts`, opt-in `recall` /
  `remember` hooks on `runAgent` surfacing as `AgentMemoryPart`. Writes are always
  explicit (caller-supplied), mirroring Anthropic's model-driven memory tool.
  Becomes the first `ContextSource` via a thin `memorySource()` adapter — the
  interface stays unchanged.
- [ ] **Markdown/file memory store** — `dendra/memory/node`: `createMarkdownMemory`
  (one `.md` per fact + frontmatter + an `INDEX.md` descriptor tier) and
  `loadContextFiles` (assemble `AGENTS.md`-style static context into the system
  prompt). Human-editable, git-diffable, PR-reviewable; same `MemoryStore`
  interface, node-only subpath so the edge/browser core stays `node:fs`-free.
- [x] ⭐ **Source #2 — tools** (shipped 0.3.0). `lazyToolset(tools, { pin, k })`
  defers a large toolset behind a `search_tools` meta-tool: the model gets a
  compact menu plus the meta-tool, searches, and only the matching schemas enter
  context (a 100-tool connector costs ~1 slot until used). `runAgent({ lazyToolset })`
  grows its live tool set as `search_tools` loads more; names are sanitized once
  and mapped back so the executor still gets the original. Opt-in; default stays
  "expose everything." _Still to add: include/exclude filters, a shared token
  budget (comes with the manager)._
- [ ] **Source #3 — skills** (progressive disclosure). A `Skill` = `{ name,
  description, instructions, tools? }`; descriptions are always in context, a
  `load_skill` meta-tool reveals the instructions **and** un-defers that skill's
  tools. `defineSkill({ …, router: appRouter.invoices })` makes "a skill =
  instructions + the router namespace it governs" — tools and skills stop being
  separate silos.
- [ ] **Eviction — working-window history**. `compactHistory` with an explicit
  **`strategy`** mirroring Anthropic's split: `"clear-tool-results"` (delete stale
  tool outputs) vs `"summarize"` (model summary of old turns) vs `"drop-oldest"`.
- [x] **The manager — `createContextManager`** (shipped 0.5.0). Assembles
  descriptors from every source into the system prompt, owns the meta-tools,
  enforces one shared token budget across memory + tools + skills + history, and
  runs eviction. Wired in via `runAgent({ context })` with `memorySource` and
  `toolSource`; skills plug in as they land.

### Deepen the AI / MCP differentiator (model & protocol reach)
- [ ] ⭐ **`dendra/openai`** — a `runAgent` for the OpenAI SDK, mirroring
  `dendra/anthropic`, so the agentic loop isn't Anthropic-only.
- **Amazon Bedrock support** — two parts:
  - [x] (a) `runAgent`'s `client` type is now **structural** (only requires
    `messages.stream`), so `@anthropic-ai/bedrock-sdk`'s `AnthropicBedrock` drops in
    with no cast. _Shipped in 0.1.1._
  - [ ] (b) **`dendra/bedrock`** — a `runAgent` over the Bedrock **Converse** API that
    maps the plain toolset to `toolSpec`, so *any* Bedrock model (Claude, Llama,
    Titan, Mistral) works, not just Claude.
- [ ] **Vercel AI SDK interop** — a thin adapter exposing `mergeToolsets()` output as
  AI SDK `tools`, so dendra is the API/tool layer *under* whatever model stack you
  already use. Complement, not compete (see Positioning).
- [ ] **MCP tool annotations** — mark tools `readOnly` / `destructive` and emit the
  corresponding MCP hints, with a **confirmation / human-in-the-loop hook** for
  dangerous calls.
- [ ] **MCP resources & prompts** — expose read-only data as MCP *resources* and
  reusable *prompts*, not just tools — a complete MCP server, not tools-only.
  (Skills can surface as MCP prompts — see the context layer above.)
- [ ] **`dendra/mcp-client`** (optional) — generalize the example's connection
  registry (transports, lifecycle) into a thin opt-in helper; core stays
  auth-agnostic and takes an already-connected client.

### `create-dendra-app` — spec

Goal: `npm create dendra-app@latest my-app` → a **running, typechecking** app in
under a minute that models dendra's conventions (so people learn the right
patterns from line one).

**Templates** (prompt or `--template`), each a runnable Next.js App Router app:
- `minimal` — the define→serve→call trio in the fewest files: `server/router.ts`
  (an `add` + a small `notes` example), `server/context.ts`,
  `app/rpc/[...path]/route.ts`, `lib/api.ts`, and a `page.tsx` calling the typed
  client. No DB, no AI.
- `mcp` ⭐ — `minimal` plus `.ai()` tools, a remote MCP route (`app/api/mcp`), a
  stdio `mcp-server.ts`, and a printed snippet to connect Claude. The flagship demo.
- `full` — trimmed showcase: SQLite+Drizzle notes, real-time pub/sub, a
  generative-UI chat (`dendra/anthropic` + `dendra/react`), MCP both directions.

A `--mcp` flag can also layer MCP onto `minimal`.

**Every generated app ships with:** correct `runtime = "nodejs"` + `dynamic` on
streaming routes; `createContext` building `ctx` with auth as a commented `.use()`
stub (never in the framework); `satisfies RouterRecord`; `.env.example`,
`.gitignore`, scripts (`dev`/`build`/`typecheck`), and a short README with run +
"connect Claude" steps.

**CLI UX:** interactive prompts, fully flaggable for CI (`--template`, `--mcp`,
`--pm`, `--no-install`, `--no-git`, `--yes`); detects the package manager from the
invocation; prints next steps on finish.

**Implementation:** its own tiny, near-zero-dep package `create-dendra-app`;
templates are real files copied + token-replaced; templates versioned against the
dendra version they target.

**Quality bar:** CI scaffolds every template and runs `tsc --noEmit` + `next build`
— a generated app must never be broken. (This is the whole point.)

**Out of scope (v1):** no auth-provider wiring, no ORM menu beyond the `full`
default, no CSS-framework choice — keep it to 2–3 questions; link docs for the rest.

**Build order:** `minimal` + `mcp` first (ship), then `full`.

---

## 0.3.0 and later — candidates

- [ ] **SSE subscriptions** _(scheduled for 0.10)_ — real-time without standing up WebSocket infra.
- [ ] **Serialization transformers** (superjson-style; honest types come first in 0.8, [#3](https://github.com/zeestack/dendra/issues/3)) — Dates / Maps / BigInt over the wire.
- [x] **File uploads** (multipart). _Shipped 0.7.0 with downloads; see Field requests._
- [ ] **Observability hooks** — logging / tracing / OpenTelemetry via middleware.
- [ ] **Edge streaming** — investigate Web Streams so streaming isn't Node-only.
- [ ] **Typed client errors** — discriminated error results and error-formatting hooks.
- [ ] **tRPC → dendra codemod** — slash switching cost for existing codebases.
- [ ] **More examples** — minimal starter, an auth example, an edge example.
- [ ] **Versioned docs site** with runnable playground.

---

## Field requests — Question Tool

From adopting dendra in a multi-tenant Next.js app (Postgres, Bedrock, Better
Auth). Full notes, with the proposed APIs: [`docs/requests/question-tool.md`](docs/requests/question-tool.md).
If only two get built: **files** and **after-hooks** — the two places the app
has to step outside dendra to stay safe.

### Must have
- [x] ⭐ **Files in and out** (shipped 0.7.0) — `s.file({ types, maxBytes })` parsed from
  `multipart/form-data` (type checked from the bytes, not just the header),
  `.returns("file")` for binary responses that still run the `.use()` chain, and a
  typed client that sends `File`/`Blob` and returns `Blob`. _Extends "File uploads
  (multipart)" above with the download half._
- [x] ⭐ **After-handler hooks** (shipped 0.6.0) — `.after(({ ctx, input, result, error, durationMs,
  path }) => …)` on every transport (RPC, REST, caller, WebSocket, AI/MCP); errors
  in the hook are logged, not returned. _The primitive "Observability hooks" builds on._
- [ ] **`inspectRouter(appRouter)`** _(scheduled for 0.9, see Next)_ — `[{ path, kind, method, restPath,
  middlewares, ai, meta }]`, plus named middleware and typed `.meta()`, so a test
  can fail the build when a procedure lacks its tenant or role check.
- [ ] **Safe-by-default AI** _(scheduled for 0.9, see Next)_ — `.noAi()` (build-time error if `.ai()` is also set)
  and `.ai({ confirm: true })` returning a pending action a person approves before
  the handler runs. _Overlaps MCP annotations + the 1.0 security review._

### Should have
- [x] **Background jobs** _(0.9, [#7](https://github.com/zeestack/dendra/issues/7))_ — `.background(handler)` → `{ jobId }` with status /
  progress / result / error, one-running-job-per-key, a pluggable store (Postgres),
  a progress subscription, and Next.js `after()`.
- [x] **Postgres pub/sub** _(0.9, [#6](https://github.com/zeestack/dendra/issues/6))_ — `createPgPubSub(pool)` over `LISTEN/NOTIFY`,
  same interface as the Redis adapter.
- [ ] **Idempotency** — `.idempotent({ key, ttl })` returns the first result for repeats.

### Nice to have
- [x] `CONFLICT` (409) and `TOO_MANY_REQUESTS` (429) error codes. _Shipped 0.4.0,
  along with `UNPROCESSABLE` (422) and `NOT_IMPLEMENTED` (501)._
- [ ] Next.js helpers _(scheduled for 0.10, [#8](https://github.com/zeestack/dendra/issues/8))_ — `createServerCaller(router, createContext)` reading
  `headers()`, and mapping `NOT_FOUND` → `notFound()`, `UNAUTHORIZED` → sign-in redirect.
- [ ] `useProcedure(api.x.get, input, { refetchWhile })` polling hook (or fold into
  `dendra/react-query`).
- [ ] Better Auth recipe in the docs (session in `createContext`, org/role as middleware).
- `dendra/bedrock` — already planned above.

---

## Toward 1.0

1.0 is about **stability**, not more surface area:

- API stability review and a documented deprecation / upgrade policy.
- Hardened test coverage (runtime + type-level) and real-world dogfooding: nothing reaches 1.0 without
  being used in a production app.
- Performance baselines locked in via CI benchmarks.
- Security review of the AI/MCP exposure path (tool auth, annotations, confirmation).
- Complete, versioned documentation.

APIs may change before 1.0; breaking changes will be called out in release notes.

---

Have an opinion on priorities? Open an issue or discussion at
<https://github.com/zeestack/dendra>.
