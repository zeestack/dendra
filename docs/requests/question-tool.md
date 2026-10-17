# What a real app wants from dendra: Question Tool

Field notes from adopting dendra in **Question Tool** (TechFoundry's content and AI-visibility product: Next.js 15 App Router, Postgres, Amazon Bedrock, Better Auth, several users per organisation, many client workspaces). Written 17 October 2026 against dendra 0.3.0.

The app needs every request checked against the user's organisation and workspace, an audit trail of who did what, AI usage recorded per workspace, and some actions (Approve, Publish) that only an approver may run and that must never become AI tools. These are the gaps that forced custom code, most valuable first.

## Must have

### 1. Files in and out

**Need:** five routes can't be dendra procedures today: cover image, product photo, product photo upload, Markdown download, CSV upload. Each needs its own copy of the tenant check, which is exactly where cross-tenant leaks happen.

**Ask:**
- File input: `.input(s.object({ workspaceId: s.number(), file: s.file({ types: ["image/png", "image/jpeg", "image/webp"], maxBytes: 8_000_000 }) }))`, parsed from `multipart/form-data`, with the type checked from the file's bytes, not only the browser's header.
- Binary output: `.returns("file")` (or a `Response` passthrough) that sets `Content-Type`, `Content-Disposition` and caching, and still runs the `.use()` chain.
- The typed client accepts a `File` or `Blob` and returns a `Blob` (plus a URL helper for `<img src>`).

Overlaps the roadmap's "File uploads (multipart)"; binary responses are the other half.

### 2. Hooks that run after the handler

**Need:** middleware only runs before the handler. The audit trail and usage recording need the outcome: success or failure, the result, the error code, the time taken, and the context (user, workspace).

**Ask:** `route.use(...)` stays; add `.after(({ ctx, input, result, error, durationMs, path }) => …)` (or `onSuccess` / `onError`), running on every transport (RPC, REST, caller, WebSocket, AI/MCP). Errors thrown in an after-hook are logged, not returned to the caller.

Overlaps "Observability hooks"; this is the generic primitive those would build on.

### 3. Inspect the router

**Need:** a test that walks the router and fails the build if a procedure lacks the tenant middleware, a restricted procedure lacks its role check, or a sensitive procedure is an AI tool. Today that means reading internals.

**Ask:** `inspectRouter(appRouter)` → `[{ path, kind, method?, restPath?, middlewares: string[] /* names */, ai: boolean, meta }]`, plus named middleware (`route.use(tenant, { name: "tenant" })` or `defineMiddleware("tenant", fn)`) and typed metadata (`.meta({ restricted: "approver" })`).

### 4. Safe by default for AI tools

**Need:** Approve and Publish put content live on a client's website. They must never be callable by a model, even by mistake.

**Ask:**
- Router-level `aiPolicy: "explicit"` (only `.ai()` procedures become tools; already true) plus `.noAi()` that throws at build time if `.ai()` is also present.
- **Human confirmation for tool calls:** `.ai({ confirm: true })` makes the tool return a pending action that a person approves in the UI before the handler runs (with the proposal in the audit trail).
- `inspectRouter` shows both, so tests can assert them.

Overlaps "Security review of the AI/MCP exposure path (tool auth, annotations, confirmation)" in Toward 1.0.

## Should have

### 5. Background jobs

**Need:** runs, briefs, drafts and covers all follow "start, return an id, keep working after the response, poll for status, survive a refresh, fail stale jobs after a restart, never start two from a double click". The app hand-rolls all of it.

**Ask:** `.background(handler)` returning `{ jobId }`, with built-in `status` / `progress` / `result` / `error`, an idempotency key per parent ("one running job per draft"), a pluggable store (Postgres adapter), and a subscription for progress. In Next.js it should use `after()`.

### 6. Postgres pub/sub

**Need:** live run progress, board updates and editor presence, without adding Redis to a Postgres-only stack.

**Ask:** `createPostgresPubSub(pool)` using `LISTEN/NOTIFY`, matching the Redis adapter's interface. Pairs with the roadmap's SSE subscriptions.

### 7. Request-once keys

**Need:** Approve clicked twice must publish once.

**Ask:** `.idempotent({ key: ({ input, ctx }) => … , ttl })` returning the first result for repeats.

## Nice to have

- **`CONFLICT` (409) and `TOO_MANY_REQUESTS` (429)** error codes; the app already answers 409 for "draft isn't finished yet".
- **Next.js helpers:** `createServerCaller(router, createContext)` that reads `headers()` itself, and a mapper that turns `NOT_FOUND` into `notFound()` and `UNAUTHORIZED` into a redirect to sign-in in Server Components.
- **`dendra/bedrock`** (already on the roadmap): Converse API tool loop for Claude and non-Claude models on Bedrock.
- **A data hook** in `dendra/react`: `useProcedure(api.drafts.get, input, { refetchWhile: (d) => d.status === "running" })`, replacing hand-written polling.
- **Better Auth recipe** in the docs: session in `createContext`, organisation and role checks as middleware.
- **README version:** the Status section says v0.1.1; npm has 0.3.0.

## If only two get built

**1 (files)** and **2 (after-hooks)**. They remove the two places where this app has to step outside dendra to stay safe: file routes with their own tenant checks, and audit or usage recording that can't see the outcome of a call.
