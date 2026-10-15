// dendra context layer — `createContextManager` (see design/context-management.md).
//
// Memory, tools, skills, and history share one shape: compact descriptors are
// always in context, full content is pulled in on demand, and everything draws
// from ONE token budget. This file is the engine that unifies them. It wraps the
// pieces that already exist — `MemoryStore` recall/remember (dendra/memory) and
// `lazyToolset` (search_tools) — behind a single `ContextManager` that `runAgent`
// drives: prepare → run → route meta-tool calls → commit.
//
// Model-agnostic and zero-dependency: no tokenizer (you inject `count`), no
// embedder (that lives in your MemoryStore), no sandbox. Entirely opt-in — a
// `runAgent` with no `context` behaves exactly as before.

import {
  recallMemory,
  rememberFacts,
  type MemoryStore,
  type MemoryRecord,
} from "./memory.ts";
import { lazyToolset, type LazyToolsetOptions } from "./context.ts";

/** Everything a source needs to know about the current request. */
export interface Turn {
  /** The conversation so far, adapter-shaped (opaque to the manager). */
  messages: unknown[];
  /** The latest user message as plain text — the default recall/search query. */
  lastUserText: string;
  /** The final assistant text, set before `commit` so write-backs can use it. */
  assistantText?: string;
  signal?: AbortSignal;
}

/** The shared budget every source + history eviction draws from. */
export interface Budget {
  maxTokens: number;
  /** Headroom reserved for the model's own output. */
  reserve: number;
  /** Pluggable token counter — no tokenizer ships in core. */
  count: (text: string) => number;
}

/** Content a source pulled into the turn. */
export interface Loaded {
  /** System text to inject (recalled memory, a loaded skill's instructions). */
  text?: string;
  /** Provider tool defs to add to the live, callable set (un-deferred tools). */
  tools?: unknown[];
  /** Records for a renderable context part (e.g. recalled / saved memory). */
  records?: MemoryRecord[];
}

/** One expandable context provider (memory, tools, skills, …). */
export interface ContextSource {
  name: string;
  /** Provider tool defs exposed from the first turn (meta-tool + pinned tools). */
  initialTools?(): unknown[];
  /** Always-on system text (e.g. the lazy-tool menu). */
  systemText?(): string;
  /** Sanitized→original tool-name pairs the executor needs (for lazy tools). */
  nameMap?(): Iterable<[string, string]>;
  /** Names of meta-tools this source handles (routed to it, not executed). */
  metaNames?(): string[];
  /** Auto-select relevant content before the model runs (memory recall). */
  select?(turn: Turn): Promise<Loaded | null>;
  /** Handle a meta-tool call owned by this source; null if it isn't ours. */
  handle?(name: string, input: unknown, turn: Turn): { result: unknown; loaded: Loaded } | null;
  /** Write-backs after the turn (memory.remember). */
  commit?(turn: Turn): Promise<Loaded | null>;
}

/** What `prepare` hands back to the agent loop. */
export interface PreparedContext {
  /** Combined system additions (recalled blocks + menus). */
  system: string;
  /** Initial tool defs to add (meta-tools + pinned tools). */
  tools: unknown[];
  /** True if a source owns the tool list (then the caller's own tools are deferred). */
  ownsTools: boolean;
  /** Sanitized→original name map for the executor. */
  nameMap: Map<string, string>;
  /** Meta-tool names to route to the manager instead of executing. */
  metaNames: Set<string>;
  /** Auto-selected items + their source, for emitting context parts. */
  selected: Array<{ source: string; loaded: Loaded }>;
}

export interface ContextManager {
  readonly budget: Budget;
  /** Inject descriptors + auto-selected content; collect the meta-tools. */
  prepare(turn: Turn): Promise<PreparedContext>;
  /** Route a meta-tool call (search_tools / …) to its source. */
  handle(
    name: string,
    input: unknown,
    turn: Turn,
  ): { source: string; result: unknown; loaded: Loaded } | null;
  /** Fit history to the budget (pluggable; identity by default). */
  compact(messages: unknown[]): Promise<unknown[]>;
  /** Write-backs after the turn (memory.remember). */
  commit(turn: Turn): Promise<Array<{ source: string; loaded: Loaded }>>;
}

export interface ContextManagerOptions {
  budget: {
    maxTokens: number;
    /** Defaults to 10% of `maxTokens`. */
    reserve?: number;
    count: (text: string) => number;
  };
  sources: ContextSource[];
  history?: {
    /**
     * Fit the conversation to the budget. History structure is provider-specific
     * (and tool_use/tool_result pairing is easy to break), so eviction is a hook
     * you supply rather than a built-in guess. Omit to leave history untouched.
     */
    compact?: (messages: unknown[], budget: Budget) => unknown[] | Promise<unknown[]>;
  };
}

export function createContextManager(opts: ContextManagerOptions): ContextManager {
  const budget: Budget = {
    maxTokens: opts.budget.maxTokens,
    reserve: opts.budget.reserve ?? Math.ceil(opts.budget.maxTokens * 0.1),
    count: opts.budget.count,
  };
  const sources = opts.sources;
  const serialize = (messages: unknown[]): string => {
    try {
      return JSON.stringify(messages);
    } catch {
      return "";
    }
  };

  return {
    budget,

    async prepare(turn) {
      const metaNames = new Set<string>();
      const nameMap = new Map<string, string>();
      const tools: unknown[] = [];
      const systemParts: string[] = [];
      let ownsTools = false;

      for (const s of sources) {
        if (s.initialTools) {
          const t = s.initialTools();
          if (t.length) ownsTools = true;
          tools.push(...t);
        }
        if (s.systemText) {
          const t = s.systemText();
          if (t) systemParts.push(t);
        }
        if (s.metaNames) for (const n of s.metaNames()) metaNames.add(n);
        if (s.nameMap) for (const [k, v] of s.nameMap()) nameMap.set(k, v);
      }

      // Budget: tokens already spent by the conversation + the fixed descriptors.
      const limit = budget.maxTokens - budget.reserve;
      let used =
        budget.count(serialize(turn.messages)) +
        systemParts.reduce((n, t) => n + budget.count(t), 0);

      const selected: Array<{ source: string; loaded: Loaded }> = [];
      for (const s of sources) {
        if (!s.select) continue;
        const loaded = await s.select(turn);
        if (!loaded) continue;
        const cost = loaded.text ? budget.count(loaded.text) : 0;
        if (cost && used + cost > limit) continue; // budget exhausted — skip it
        used += cost;
        if (loaded.text) systemParts.push(loaded.text);
        selected.push({ source: s.name, loaded });
      }

      return {
        system: systemParts.filter(Boolean).join("\n\n"),
        tools,
        ownsTools,
        nameMap,
        metaNames,
        selected,
      };
    },

    handle(name, input, turn) {
      for (const s of sources) {
        if (!s.handle) continue;
        const h = s.handle(name, input, turn);
        if (h) return { source: s.name, ...h };
      }
      return null;
    },

    async compact(messages) {
      if (opts.history?.compact) return opts.history.compact(messages, budget);
      return messages;
    },

    async commit(turn) {
      const out: Array<{ source: string; loaded: Loaded }> = [];
      for (const s of sources) {
        if (!s.commit) continue;
        const l = await s.commit(turn);
        if (l) out.push({ source: s.name, loaded: l });
      }
      return out;
    },
  };
}

// ── Sources (thin adapters over the existing pieces) ────────────────────────

export interface MemorySourceOptions {
  /** Recall config, or `false` to retrieve nothing. Default `{ k: 6 }`. */
  recall?:
    | false
    | {
        k?: number;
        minScore?: number;
        kind?: string;
        /** Derive the search string from the turn (default: the last user text). */
        query?: (turn: Turn) => string;
      };
  /**
   * Decide what to persist after the turn. You supply it — the framework never
   * decides what to remember. Receives the final assistant text + messages and
   * returns the strings to save. Omit for read-only memory.
   */
  remember?: (turn: {
    text: string;
    messages: unknown[];
  }) => string[] | Promise<string[]>;
}

/** A context source backed by a `MemoryStore`: select = recall, commit = remember. */
export function memorySource(
  memory: MemoryStore,
  opts: MemorySourceOptions = {},
): ContextSource {
  return {
    name: "memory",
    async select(turn) {
      if (opts.recall === false) return null;
      const r = opts.recall ?? {};
      const query = r.query ? r.query(turn) : turn.lastUserText;
      const { records, block } = await recallMemory(memory, query, {
        k: r.k,
        minScore: r.minScore,
        kind: r.kind,
      });
      return records.length ? { text: block, records } : null;
    },
    async commit(turn) {
      if (!opts.remember) return null;
      const facts = await opts.remember({
        text: turn.assistantText ?? "",
        messages: turn.messages,
      });
      const saved = await rememberFacts(memory, facts);
      return saved.length ? { records: saved } : null;
    },
  };
}

export type ToolSourceOptions = LazyToolsetOptions;

/**
 * A context source that defers a formatted toolset behind `search_tools`
 * (wraps `lazyToolset`). The model loads tools on demand; only the chosen
 * schemas enter context.
 */
export function toolSource(
  tools: unknown[],
  opts: ToolSourceOptions = {},
): ContextSource {
  const lazy = lazyToolset(tools, opts);
  return {
    name: "tools",
    initialTools: () => lazy.tools,
    systemText: () => lazy.menu,
    nameMap: () => lazy.nameMap,
    metaNames: () => [lazy.metaName],
    handle(name, input) {
      const h = lazy.handle(name, input);
      if (!h) return null;
      return { result: h.result, loaded: { tools: h.loaded } };
    },
  };
}
