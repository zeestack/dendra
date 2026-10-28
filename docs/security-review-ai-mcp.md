# Security review: the AI/MCP exposure path (#42)

How a procedure becomes something a model can call, and what stops it doing
more than it should. Reviewed against 0.12.1 on 2026-10-28. Each finding is
fixed in the same PR or filed as an issue.

## What holds

- **Opt-in exposure.** `toToolset`, `mcpToolDefinitions` and the tool executor
  only see procedures marked `.ai()`. `.noAi()` and `.ai()` throw if combined.
  File inputs can't be `.ai()`.
- **Guards on every transport.** HTTP, REST, WebSocket, `createCaller`, the tool
  executor and approvals all go through `invokeWith`/`invokeStream`: input is
  validated, then every `.use()` runs, then the handler. A tool call can't skip a
  guard the HTTP route has.
- **The model gets the user's permissions, not more.** `createToolExecutor(router,
  ctx)` runs every call with the ctx it was given. The app must build that ctx
  from the request (see finding 4).
- **Validation before anything runs.** Model arguments go through the same
  Standard Schema as HTTP input. A procedure with no `.input()` advertises an
  empty object schema and its handler gets the raw arguments; handlers without
  `.input()` don't read `input`, so this is accepted.
- **Approvals fail closed.** A confirm tool without `approvals` throws, and
  approvals must come from `createApprovals()`. Proposals run the guards with
  the proposer's ctx; approval re-validates the stored input and re-runs the
  guards with the approver's ctx; `take()` makes each decision happen once. With
  `scope`, other tenants' action ids answer NOT_FOUND, as missing ones do.
- **Name resolution.** A tool name only resolves to something carrying the
  `_dendra` brand that procedures have, so `__proto__`, `constructor` and the
  like are NOT_FOUND (tested).
- **MCP annotations.** `.get()` tools are marked `readOnlyHint`; confirm tools
  `destructiveHint`. Everything else carries no annotation, which the MCP spec
  treats as possibly destructive: the safe default.

## Findings

### 1. Unexpected error messages reached clients and the model (fixed)

Any error other than a `DendraError` was sent with its own `message`: over HTTP
(unary, batch, NDJSON, SSE), over WebSockets, in failed job snapshots streamed
to browsers, in MCP bridge results, and in `runAgent` tool results. A database
driver's error can include a connection string, SQL, hostnames or file paths;
for tools, the model sees it and can repeat it to the user.

**Fix:** a shared `publicError()`. A `DendraError` passes through as the app's
deliberate message; anything else becomes `{ code: "INTERNAL", message:
"Internal error" }`, and the original is logged with `console.error` (jobs keep
reporting through `onError`; `jobs.stop()` still returns full messages to the
operator). `createToolExecutor` now only throws `DendraError`s, so a
hand-written agent loop is covered too. Under the versioning policy, error
message text isn't breaking, but the release notes call it out.

### 2. The tool executor told the model which procedures exist (fixed)

A missing tool and a procedure without `.ai()` gave different errors ("not
found" vs "not exposed to AI"), so a model could probe for procedures it was
never given. Both now answer `NOT_FOUND: Tool 'x' not found`.

### 3. The example's stdio MCP server could call any procedure (fixed)

`examples/nextjs-app/mcp-server.ts` mapped unknown tool names straight through
(`safeToOriginal.get(name) ?? name`) and calls the app over plain RPC, where
`.ai()` isn't checked. An MCP client could call procedures without `.ai()`,
including `.noAi()` ones, and a confirm tool would run with no approval. It now
rejects names it didn't list and leaves confirm tools out (they need the
in-app endpoint, which has approvals). The in-app endpoint (`app/api/mcp`) had
the same fallback but runs through the tool executor, which refused such
calls; the fallback is removed there too.

### 4. The example's agent route trusted a user id from the request body (fixed)

`app/api/agent/route.ts` built ctx with `directContext(userId)` from the JSON
body, so any caller could act as any user, including reading their memories
through the `.ai()` memory tools. It now uses `createContext(req)`, the same
session or token check as every other route. The docs already said ctx must
come from the request; this example contradicted them.

### 5. `lazyToolset` could route a call to the wrong tool (fixed)

Tool names are sanitized for model APIs (`.` → `_`). Two tools such as
`posts.delete` and `posts_delete` became the same name, and calls went to
whichever came last. It now throws at construction, naming both.

### 6. External MCP errors (fixed)

`createMcpToolSource` threw remote errors as plain `Error`s, which finding 1's
masking would have hidden from the model. Remote error text was written for the
model, so it's now a `DendraError` with a new `BAD_GATEWAY` (502) code and passes
through.

## Filed

- **A streaming tool that never ends hangs the agent:** #57. `.ai()` on a
  `.stream()` collects every chunk before returning, with no limit or
  cancellation. A subscription exposed as a tool never returns and grows memory.
- **External MCP tools are untrusted input:** #58. Remote tool names,
  descriptions and results go to the model verbatim (prompt injection), and
  there's no way to require approval for a remote tool.
- **Per-tool MCP annotations:** #59. `.ai()` can't set `idempotentHint`,
  `openWorldHint` or mark a non-GET tool read-only. Already on the ROADMAP.

## Accepted

- **A pending action outlives a router change.** If a procedure stops being a
  confirm tool (or a tool at all) after a proposal, `approve` still runs it. The
  approver's guards run first, so it can't do more than the approver could, and
  the window is a deploy. Not worth a check that would strand such actions.
- **`createToolExecutor` keeps the ctx it was made with.** Making one at startup
  with a service ctx would give the model that service's rights. The docs say to
  create it per request; the type can't enforce it.
