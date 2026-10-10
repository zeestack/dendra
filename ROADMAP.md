# Roadmap

dendra is pre-1.0 and experimental. This roadmap is a direction, not a promise —
scope and order will shift with feedback. Open an issue or discussion to weigh in.

**Guiding principle:** don't try to out-tRPC tRPC on plain HTTP. Win on the
**AI/MCP seam** (one definition is also an LLM tool and an MCP server, both
directions) and on **ease of adoption**. Keep the core zero-dependency; new
integrations ship as optional subpath exports with their own peer deps.

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
- [ ] ⭐ **`create-dendra-app`** — `npx create-dendra-app` scaffolds a working
  Next.js + dendra app (router, adapters, typed client, MCP route, example
  procedures). One command to a running app.
- [ ] ⭐ **`dendra/react-query`** — typed TanStack Query hooks (`useQuery` /
  `useMutation`) over the router. Closes the biggest tRPC parity gap. Optional peer dep.
- [ ] ⭐ **Benchmarks** vs tRPC / Hono (throughput, cold start, bundle size) — a
  credible performance story.
- [ ] **Package-page docs** — absolute image URLs in the README so the npm and
  GitHub Packages pages render the hero and diagrams (currently relative paths
  break off-repo). Ships with the next published version.

### Deepen the AI / MCP differentiator
- [ ] ⭐ **`dendra/openai`** — a `runAgent` for the OpenAI SDK, mirroring
  `dendra/anthropic`, so the agentic loop isn't Anthropic-only.
- [ ] **MCP tool annotations** — mark tools `readOnly` / `destructive` and emit the
  corresponding MCP hints, with a **confirmation / human-in-the-loop hook** for
  dangerous calls.
- [ ] **MCP resources & prompts** — expose read-only data as MCP *resources* and
  reusable *prompts*, not just tools — a complete MCP server, not tools-only.
- [ ] **`dendra/mcp-client`** (optional) — generalize the example's connection
  registry (transports, lifecycle) into a thin opt-in helper; core stays
  auth-agnostic and takes an already-connected client.

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
