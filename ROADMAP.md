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
- [ ] **Package-page docs** — absolute image URLs in the README so the npm and
  GitHub Packages pages render the hero and diagrams (currently relative paths
  break off-repo). Ships with the next published version.

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
- [ ] ⭐ **Source #2 — tools** (tool-context management). Keep large merged
  toolsets from blowing the window: include/exclude filters, tag/namespace
  grouping, and **lazy exposure** — a compact set plus a `search_tools` meta-tool
  that pages in full definitions on demand (a 200-tool connector costs ~1 slot
  until used). Opt-in; default stays "expose everything."
- [ ] **Source #3 — skills** (progressive disclosure). A `Skill` = `{ name,
  description, instructions, tools? }`; descriptions are always in context, a
  `load_skill` meta-tool reveals the instructions **and** un-defers that skill's
  tools. `defineSkill({ …, router: appRouter.invoices })` makes "a skill =
  instructions + the router namespace it governs" — tools and skills stop being
  separate silos.
- [ ] **Eviction — working-window history**. `compactHistory` with an explicit
  **`strategy`** mirroring Anthropic's split: `"clear-tool-results"` (delete stale
  tool outputs) vs `"summarize"` (model summary of old turns) vs `"drop-oldest"`.
- [ ] **The manager — `createContextManager`**. Assembles descriptors from every
  source into the system prompt, owns the meta-tools, enforces one shared token
  budget across memory + tools + skills + history, and runs eviction. Extract it
  once sources #1 and #2 both exist (don't design the abstraction in a vacuum).

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

- [ ] **SSE subscriptions** — real-time without standing up WebSocket infra.
- [ ] **Serialization transformers** (superjson-style) — Dates / Maps / BigInt over the wire.
- [ ] **File uploads** (multipart).
- [ ] **Observability hooks** — logging / tracing / OpenTelemetry via middleware.
- [ ] **Edge streaming** — investigate Web Streams so streaming isn't Node-only.
- [ ] **Typed client errors** — discriminated error results and error-formatting hooks.
- [ ] **tRPC → dendra codemod** — slash switching cost for existing codebases.
- [ ] **More examples** — minimal starter, an auth example, an edge example.
- [ ] **Versioned docs site** with runnable playground.

---

## Toward 1.0

1.0 is about **stability**, not more surface area:

- API stability review and a documented deprecation / upgrade policy.
- Hardened test coverage (runtime + type-level) and real-world dogfooding.
- Performance baselines locked in via CI benchmarks.
- Security review of the AI/MCP exposure path (tool auth, annotations, confirmation).
- Complete, versioned documentation.

APIs may change before 1.0; breaking changes will be called out in release notes.

---

Have an opinion on priorities? Open an issue or discussion at
<https://github.com/zeestack/dendra>.
