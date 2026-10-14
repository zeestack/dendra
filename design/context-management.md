# Design note: `dendra/context` — unified context management

**Status:** draft / design. Memory (source #1) is shipped in 0.2.0; the manager and
the other sources are not built yet. This note locks the architecture so the pieces
are built _into_ one layer instead of as unrelated features.

## The insight

Memory, tools, skills, and chat history are the **same two-tier shape**:

| | Compact tier (always in context) | Full tier (loaded on demand) | Loaded by |
|---|---|---|---|
| **Memory** | `INDEX.md` / descriptor one-liners | the full fact | auto-recall (relevance) |
| **Tools** | name + description (deferred) | the JSON schema → callable | model (`search_tools`) |
| **Skills** | name + description | instructions + its tools | model (`load_skill`) |
| **History** | recent turns | older turns | — (and _evicted_ when tight) |

One engine: **compact descriptors always present, full content pulled on demand,
everything drawn from one token budget, stale content evicted when it tightens.**

## Non-goals (the boundary)

- dendra does **not** run a sandbox to execute skill scripts, embed text, or count
  tokens — those are injected (an embedder in a `MemoryStore`, a `count` fn in the
  budget, a summarizer fn for history). Core stays zero-dependency.
- Context management is **opt-in**. A `runAgent` call with no `context` behaves
  exactly as today.
- Storage/scoping stay the app's job (per-user `MemoryStore`, per-tenant routers),
  exactly like `ctx.db` / `ctx.pubsub`.

## The primitive: `ContextSource`

```ts
/** A compact, always-in-context pointer to expandable content. */
interface Descriptor {
  id: string;         // stable handle passed back to expand()
  label: string;      // short name shown to the model
  hint?: string;      // one-line description (the "index" tier)
}

/** Content the manager has pulled into context, with its token cost. */
interface Loaded {
  id: string;
  text: string;       // what gets injected (system block or tool schema)
  tokens?: number;    // measured if a counter is available
}

interface ContextSource {
  name: string;

  /** Compact descriptors to keep in context every turn (cheap). */
  descriptors(turn: Turn): Promise<Descriptor[]>;

  /** Expand one descriptor to its full content, on demand. */
  expand(id: string, turn: Turn): Promise<Loaded>;

  /**
   * Optional: auto-select & inject relevant items before the model runs
   * (memory recall does this; tools/skills leave it to the model instead).
   */
  select?(turn: Turn, budget: Budget): Promise<Loaded[]>;

  /** Optional: the meta-tool the model calls to pull from this source. */
  metaTool?: { name: string; description: string };

  /** Optional: write-back after the turn (memory.remember lives here). */
  commit?(turn: Turn): Promise<Loaded[]>;
}

/** Everything a source needs about the current request. */
interface Turn {
  messages: unknown[];        // adapter-shaped (Anthropic/OpenAI/…)
  lastUserText: string;
  signal?: AbortSignal;
}
```

## The budget (shared across all sources + history)

```ts
interface Budget {
  maxTokens: number;
  reserve: number;                 // headroom left for the model's output
  count: (text: string) => number; // pluggable counter (no tokenizer in core)
  remaining(): number;
}
```

## The manager: `createContextManager`

```ts
interface ContextManager {
  /** System-prompt descriptors + any auto-selected (recalled) content. */
  prepare(turn: Turn): Promise<{ system: string; metaTools: ToolDef[] }>;
  /** Route a meta-tool call (search_tools / load_skill / …) to its source. */
  handleMetaTool(name: string, args: unknown, turn: Turn): Promise<Loaded>;
  /** Evict/compact history to fit the budget. */
  compact(messages: unknown[]): Promise<unknown[]>;
  /** Write-backs after the turn (memory.remember). */
  commit(turn: Turn): Promise<void>;
}

function createContextManager(opts: {
  budget: { maxTokens: number; reserve?: number; count: (t: string) => number };
  sources: ContextSource[];
  history?: {
    strategy: "clear-tool-results" | "summarize" | "drop-oldest";
    summarize?: (msgs: unknown[]) => Promise<string>;
  };
}): ContextManager;
```

## The sources (all wrap existing pieces)

```ts
import { memorySource, toolSource, skillSource } from "dendra/context";

memorySource(ctx.memory, { recall: { k: 6 } });  // select = recall, commit = remember
toolSource(appRouter, ctx, { lazy: true });        // descriptors = tool names; expand = schema
skillSource([invoiceSkill]);                       // metaTool = load_skill
```

- **`memorySource`** adapts a `MemoryStore` (0.2.0, unchanged). `select` = `recallMemory`,
  `commit` = `rememberFacts`. Descriptors come from `store.all()` / an index.
- **`toolSource`** wraps `toToolSource(appRouter, ctx)`; descriptors are tool
  name+description, `expand` un-defers the schema, `metaTool` = `search_tools`.
- **`skillSource`** takes `Skill[]`; `expand` returns instructions and signals the
  manager to un-defer that skill's tools; `metaTool` = `load_skill`.

## Integration with `runAgent`

```ts
runAgent({
  client, model, prompt,
  context,                       // a ContextManager
});
```

Per turn, `runAgent`:
1. `context.compact(messages)` — fit history to budget.
2. `const { system, metaTools } = await context.prepare(turn)` — inject descriptors
   + any recalled memory; add the meta-tools alongside the normal toolset.
3. Run the model loop. A meta-tool call → `context.handleMetaTool(...)` →
   inject the expanded content, emit an `AgentContextPart`
   (`{ type: "context", source, op: "loaded" | "recalled" | "saved", items }`).
4. After the turn: `context.commit(turn)` — write-backs (memory), emit saved parts.

`AgentMemoryPart` (0.2.0) generalizes to `AgentContextPart`; the memory variant stays
as a back-compat alias so existing UIs keep working.

## Phasing

1. **Reframe the roadmap** around this layer. _(done)_
2. Ship **source #2 (tools)** — lazy `search_tools`, the token budget. This is the
   second concrete source and forces the budget to exist.
3. **Extract `createContextManager`** once memory + tools both exist and the shared
   shape is obvious — not before.
4. Add **skills** and **history eviction** as the manager matures.
5. Markdown `MemoryStore` + `loadContextFiles` can land anytime (additive, node-only
   subpath); it's independent of the manager.

## Why not design the manager first

The abstraction is only trustworthy once two real sources exist. Memory shipped
standalone on purpose; the tools source is the second data point. Build the manager
to fit what's demonstrably shared, then retrofit memory via `memorySource()` (a thin
adapter, no breaking change to `MemoryStore`).
