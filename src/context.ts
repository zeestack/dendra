// Tool-context management — the first piece of the unified context layer
// (see design/context-management.md). A big toolset (e.g. 100 tools from a
// merged MCP connector) is expensive to send in full every turn and hurts
// tool-selection accuracy. `lazyToolset` keeps the schemas OUT of context and
// exposes a compact menu plus a `search_tools` meta-tool; the model searches,
// the matching tools become callable, and only those full schemas enter context.
//
// Model-agnostic: it works on an already-formatted toolset (the `tools` array
// from `toToolset` / `mergeToolsets`). Tool names are sanitized to the
// `^[a-zA-Z0-9_-]+$` charset both Anthropic and OpenAI require (dots → `_`), and
// `nameMap` maps each sanitized name back to the original so the caller's
// executor still gets the dotted name.

import type { ToolFormat } from "./tools.ts";

export interface LazyToolsetOptions {
  /** Tool names to keep loaded from the start (never deferred). Dotted names ok. */
  pin?: string[];
  /** Max tools `search_tools` returns per call (default 6). */
  k?: number;
  /** Provider format of the passed tools + the meta-tool (default "anthropic"). */
  format?: ToolFormat;
  /** The meta-tool name (default "search_tools"). */
  metaName?: string;
  /** Include the compact menu of deferred tools in `menu` (default true). With a
   *  very large toolset you may omit it and let the model search blind. */
  includeMenu?: boolean;
}

export interface LazyToolset {
  /** Tools to send on the first turn: the meta-tool + any pinned tools (sanitized names). */
  tools: unknown[];
  /** A compact "name — description" menu of the deferred tools (or ""). */
  menu: string;
  /** The meta-tool's name, so the agent loop can detect its calls. */
  metaName: string;
  /** Sanitized tool name → original name, for every tool (so the executor maps back). */
  nameMap: Map<string, string>;
  /**
   * Handle a tool call by its (sanitized) name. For the meta-tool, returns the
   * result to hand back to the model plus `loaded` — the full defs of the newly
   * un-deferred tools to add to the live set. Returns null for any other tool
   * (the caller executes it).
   */
  handle(name: string, input: unknown): { result: unknown; loaded: unknown[] } | null;
}

function nameOf(tool: unknown): string {
  const t = tool as { name?: string; function?: { name?: string } };
  return t.name ?? t.function?.name ?? "";
}
function descOf(tool: unknown): string {
  const t = tool as { description?: string; function?: { description?: string } };
  return t.description ?? t.function?.description ?? "";
}
function withSafeName(tool: unknown, safe: string, format: ToolFormat): unknown {
  if (format === "openai") {
    const t = tool as { function?: object };
    return { ...t, function: { ...(t.function ?? {}), name: safe } };
  }
  return { ...(tool as object), name: safe };
}

const sanitizeName = (n: string): string => n.replace(/[^a-zA-Z0-9_-]/g, "_");
const tokenize = (s: string): string[] => s.toLowerCase().match(/[a-z0-9]+/g) ?? [];

/**
 * Wrap a formatted toolset so its schemas load on demand via `search_tools`.
 * Pass the result as `runAgent({ lazyToolset })`.
 *
 * @experimental Outside the 1.0 stability guarantee; may change in a minor release.
 */
export function lazyToolset(
  tools: unknown[],
  opts: LazyToolsetOptions = {},
): LazyToolset {
  const format = opts.format ?? "anthropic";
  const k = opts.k ?? 6;
  const metaName = opts.metaName ?? "search_tools";
  const includeMenu = opts.includeMenu ?? true;
  const pin = new Set((opts.pin ?? []).map(sanitizeName));

  const nameMap = new Map<string, string>([[metaName, metaName]]);
  // Safe-named def + a pre-tokenized haystack, keyed by sanitized name.
  const defBySafe = new Map<string, unknown>();
  const index: Array<{ safe: string; description: string; toks: string[] }> = [];
  for (const tool of tools) {
    const orig = nameOf(tool);
    if (!orig) continue;
    const safe = sanitizeName(orig);
    nameMap.set(safe, orig);
    defBySafe.set(safe, withSafeName(tool, safe, format));
    const description = descOf(tool);
    index.push({ safe, description, toks: tokenize(`${safe} ${orig} ${description}`) });
  }

  // Already-exposed names (meta-tool + pinned); never returned by search again.
  const exposed = new Set<string>([metaName, ...pin]);

  const pinnedTools = [...pin].map((n) => defBySafe.get(n)).filter(Boolean) as unknown[];
  const deferred = index.filter((t) => !pin.has(t.safe));
  const menu =
    includeMenu && deferred.length
      ? `You have ${deferred.length} more tools available but not loaded yet. Call ${metaName}(query) to load the ones you need, then call them. Tools:\n` +
        deferred.map((t) => `- ${t.safe} — ${t.description}`).join("\n")
      : "";

  function search(query: string): { name: string; description: string }[] {
    const q = new Set(tokenize(query));
    if (!q.size) return [];
    return index
      .filter((t) => !exposed.has(t.safe))
      .map((t) => {
        const hits = t.toks.reduce((n, w) => n + (q.has(w) ? 1 : 0), 0);
        const nameHit = tokenize(t.safe).some((w) => q.has(w)) ? 0.5 : 0;
        const score = (t.toks.length ? hits / Math.sqrt(t.toks.length) : 0) + nameHit;
        return { t, score };
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map((r) => ({ name: r.t.safe, description: r.t.description }));
  }

  return {
    tools: [formatMeta(metaName, format), ...pinnedTools],
    menu,
    metaName,
    nameMap,
    handle(name, input) {
      if (name !== metaName) return null;
      const query = String((input as { query?: unknown })?.query ?? "");
      const matches = search(query);
      const loaded: unknown[] = [];
      for (const m of matches) {
        if (exposed.has(m.name)) continue;
        const def = defBySafe.get(m.name);
        if (def) {
          loaded.push(def);
          exposed.add(m.name);
        }
      }
      const result =
        matches.length === 0
          ? { found: [], note: "No matching tools. Try different keywords." }
          : { found: matches, note: "These tools are now loaded and callable." };
      return { result, loaded };
    },
  };
}

function formatMeta(name: string, format: ToolFormat): unknown {
  const description =
    "Search for tools by keyword when the tool you need isn't loaded yet. Returns matching tool names/descriptions; those tools then become callable.";
  const schema = {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "What you're trying to do, e.g. 'create an invoice'",
      },
    },
    required: ["query"],
  };
  if (format === "openai") {
    return { type: "function", function: { name, description, parameters: schema } };
  }
  if (format === "anthropic") {
    return { name, description, input_schema: schema };
  }
  return { name, description, inputSchema: schema };
}
