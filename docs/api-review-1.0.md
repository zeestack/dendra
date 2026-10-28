# API stability review for 1.0 (#38)

After 1.0, any breaking change means a major version. This review lists dendra's
public surface as of 0.11.0 and proposes, for each part, whether to **keep** it,
**rename** it, mark it **experimental** (outside the 1.0 guarantee), or
**remove** it. Breaking changes land in 0.x, before 1.0.

Status: **decided 2026-10-28.** The maintainer accepted every recommendation
below; they shipped in 0.12.0. Deprecated aliases (2, 3, 7) are removed in 0.13.

## Summary of proposed changes

| # | Change | Breaking? |
|---|---|---|
| 1 | Decide whose ctx `approvals.approve` runs guards with | Behaviour, if changed |
| 2 | Move `resolveProc`, `invokeUnary`, `invokeStream` out of the main entry | Yes |
| 3 | Rename the context manager's `toolSource` (clashes with `toToolSource`) | Yes |
| 4 | Keep the low-level WebSocket pieces, marked "low-level" | No |
| 5 | Mark the agent and context layer experimental | No (labels only) |
| 6 | Take `propose` off the public `Approvals` interface | Type-only |
| 7 | Serve memory helpers from `dendra/memory` only | Yes |
| 8 | `toNextHandler`: export `GET` and `POST` only | Yes, unlikely to bite |

Everything else is proposed **keep as is**.

## 1. `approvals.approve(id, ctx)`: whose ctx?

**Today:** guards re-run with the **approver's** ctx, and the handler runs with
it. #29 asked for the **proposer's** ctx (the user the model was acting for).

- **Approver's ctx (today).** The approver must pass the guards, so an admin
  approving a member's action acts with admin rights. The handler sees the
  approver as `ctx.user`, so audit trails name the approver, not the proposer.
- **Proposer's ctx.** The action runs exactly as the model proposed it, for the
  user it was acting for. But dendra would have to store ctx, which holds db
  handles and sessions and can't be serialised. The app would have to rebuild it
  from stored ids, e.g. a `restore(action) => Ctx` option.

**Recommendation:** keep the approver's ctx, and document it as a decision. Add
`action.proposedBy` (from an optional `proposer: (ctx) => string` option), so
handlers and after-hooks can record both people. This adds, it doesn't break.

## 2. Dispatch internals in the main entry

`resolveProc`, `invokeUnary` and `invokeStream` are exported from `dendra` but
undocumented and unused outside `src/`. They exist for adapters. Once they're in
the 1.0 surface, the dispatch internals (middleware order, after-hooks, the
`CallSite` shape) are frozen too.

**Recommendation:** move them to `dendra/adapter`, marked experimental, for
people writing transports. Do the same for the `Proc`, `AnyProc`, `CallSite`
and `Transport` types. `inspectRouter` already covers reading a router.

## 3. `toolSource` vs `toToolSource`

Both are exported from `dendra` and do different things:

- `toToolSource(router, ctx)`, in the tools layer, makes `{ tools, execute }`
  from a router.
- `toolSource(tools, { pin, k })`, in the context manager, defers schemas behind
  `search_tools`.

**Recommendation:** rename the context manager's version to `lazyToolSource`,
which matches `lazyToolset` (it does the same job inside the manager).
`memorySource` doesn't clash and stays.

## 4. Two layers of WebSocket API

- **High-level:** `attachWsServer` (Origin check, limits, heartbeats) and
  `createWsConnection` (reconnects). Documented; the README recipe uses them.
- **Low-level:** `createWsSession`, `createWsClient`, `attachWs` and `connectWs`.
  Bare bindings with no Origin check and no limits. They're used by the
  examples, and they're what non-`ws` runtimes (Bun, Deno, Workers) need.

**Recommendation:** keep both, stable. In the docs, label the low-level four as
"for other runtimes; no Origin check or limits", and point browser and Node
users to the high-level pair.

## 5. Agent and context layer: experimental

`createContextManager`, `memorySource`, `toolSource`, `lazyToolset`, the
`Budget`/`Turn`/`Loaded` types, `runAgent` (`dendra/anthropic`) and
`useAssistant` (`dendra/react`). This layer moves with model APIs, and the
ROADMAP still lists `dendra/openai` and `dendra/bedrock` as plans.

**Recommendation:** ship 1.0 with these marked `@experimental` (JSDoc and docs),
outside the guarantee, so they can change in a minor version. The tool-shaping
core stays stable: `.ai()`, `toToolset`, `createToolExecutor`,
`mcpToolDefinitions`, `createMcpToolSource`, `mergeToolsets`, `createMcpBridge`
and approvals.

## 6. `Approvals.propose`

It's marked `@internal` but sits on the public `Approvals` interface, so a
custom implementation must provide it.

**Recommendation:** move it behind a symbol key, or an internal-only type the
executor uses. Apps calling `approvals.propose` would break, but it's
documented as internal.

## 7. Memory helpers exported twice

`createMemoryStore`, `recallMemory`, `rememberFacts` and `formatMemoryBlock` are
exported from both `dendra` and `dendra/memory`.

**Recommendation:** keep the `MemoryStore`/`MemoryRecord` types in core (so
`ctx.memory` can be typed), and serve the functions from `dendra/memory` only.

## 8. `toNextHandler` method list

It returns the same handler as `GET`, `POST`, `PUT`, `PATCH` and `DELETE`, but
the RPC handler answers only GET and POST. The others get 405.

**Recommendation:** return `{ GET, POST }`. REST over Next uses `toRestHandler`.

## Kept as is (stable at 1.0)

- **Procedures:** `initDendra<Ctx, Meta>()`, the `route` builder (`.input`,
  `.output`, `.use(mw, { name })`, `.after`, `.get/.post/…`, `.meta`, `.ai`,
  `.noAi`, `.handler`, `.stream`, `.background`), `RouterRecord`, class
  controllers.
- **Calling:** `createClient` (+ `ClientOptions`, `streamFormat`), `urlFor`,
  `createCaller`, `Client`/`Caller`/`Jsonify`/`CallOptions`.
- **Serving:** `toFetchHandler`, `toNodeHandler`, `toRestHandler`,
  `toOpenApiDocument`, `ServerOptions` (incl. `heartbeatMs`).
- **Wire formats:** the RPC envelope, NDJSON frames with `$error`, SSE events
  (`data`/`error`/`done`), the batch protocol. These are the hardest to change
  later, since old clients meet new servers.
- **Errors:** `DendraError`, `DendraClientError`, `ErrorCode`.
- **Files:** `s.file`, `file()`, `FileResult`.
- **Validation:** `s.*`, Standard Schema types.
- **Real-time:** `createInMemoryPubSub`, `createPubSub`, `createRedisPubSub`,
  `createPgPubSub`, `PubSub`.
- **Jobs:** `createJobs`, `createInMemoryJobStore`, `createPgJobStore`, `JobStore`
  (with `capabilities`), `followJob`, `useJob`, schedules.
- **Next:** `createServerCaller`, `orPage`.
- **Inspection:** `inspectRouter`, `RouteInfo`.

## Next steps

1. Maintainer decides the open items (1–8).
2. One PR per breaking change, in 0.12. Each change gets a deprecated alias for
   one minor version where that's cheap (2, 3, 7), per the deprecation policy (#39).
3. Add `@experimental` labels (5) and the WebSocket doc labels (4).
