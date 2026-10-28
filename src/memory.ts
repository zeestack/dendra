// dendra/memory — persistent recall for agents.
//
// Like pub/sub, the framework ships only the INTERFACE plus a tiny zero-dep
// reference store. Real apps implement `MemoryStore` over pgvector, SQLite +
// embeddings, Redis, or a managed memory service — the call sites (and the
// `runAgent` recall/remember hooks) never change. Core stays dependency-free.
//
// @experimental Outside the 1.0 stability guarantee, like the rest of the
// context layer; may change in a minor release. The `MemoryStore` types are stable.

/** One remembered item. `score` is set by `search()` (higher = more relevant). */
export interface MemoryRecord {
  id: string;
  text: string;
  /** Free-form bucket, e.g. "fact" | "preference" | "summary". */
  kind?: string;
  /** Relevance score from `search()`, roughly 0..1. Unset on `save()`. */
  score?: number;
  meta?: Record<string, unknown>;
  createdAt?: number;
}

/**
 * The contract apps implement. `all()` is optional — it exists so memory can be
 * surfaced as MCP *resources* later; stores that can't enumerate may omit it.
 */
export interface MemoryStore {
  save(
    text: string,
    opts?: { kind?: string; meta?: Record<string, unknown> },
  ): Promise<MemoryRecord>;
  search(
    query: string,
    opts?: { k?: number; kind?: string; minScore?: number },
  ): Promise<MemoryRecord[]>;
  forget(id: string): Promise<boolean>;
  all?(): Promise<MemoryRecord[]>;
}

function tokenize(s: string): string[] {
  return s.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

/**
 * Zero-dependency reference store with token-overlap scoring. Great for demos,
 * tests, and small apps; swap in a vector store for production recall with no
 * changes to callers. Pass `seed` to preload records.
 */
export function createMemoryStore(seed: MemoryRecord[] = []): MemoryStore {
  const rows: MemoryRecord[] = seed.map((r) => ({ ...r }));

  return {
    async save(text, opts) {
      const rec: MemoryRecord = {
        id: Math.random().toString(36).slice(2, 9),
        text,
        kind: opts?.kind,
        meta: opts?.meta,
        createdAt: Date.now(),
      };
      rows.push(rec);
      return { ...rec };
    },

    async search(query, opts) {
      const q = new Set(tokenize(query));
      const k = opts?.k ?? 5;
      const minScore = opts?.minScore ?? 0;
      if (q.size === 0) return [];
      return rows
        .filter((r) => !opts?.kind || r.kind === opts.kind)
        .map((r) => {
          const toks = tokenize(r.text);
          const hits = toks.reduce((n, w) => n + (q.has(w) ? 1 : 0), 0);
          // Overlap normalized by record + query length — keeps long records
          // from dominating purely by having more words.
          const score = toks.length
            ? hits / Math.sqrt(toks.length * q.size)
            : 0;
          return { ...r, score };
        })
        .filter((r) => (r.score ?? 0) > minScore)
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
        .slice(0, k);
    },

    async forget(id) {
      const i = rows.findIndex((r) => r.id === id);
      if (i < 0) return false;
      rows.splice(i, 1);
      return true;
    },

    async all() {
      return rows.map((r) => ({ ...r }));
    },
  };
}

export interface RecallOptions {
  /** Max records to retrieve (default 6). */
  k?: number;
  minScore?: number;
  kind?: string;
}

/** Format recalled records as an injectable context block (empty if none). */
export function formatMemoryBlock(records: MemoryRecord[]): string {
  if (!records.length) return "";
  return (
    "Relevant memory (use if helpful):\n" +
    records.map((r) => `- ${r.text}`).join("\n")
  );
}

/**
 * Model-agnostic recall: search the store and return the hits plus a formatted
 * block ready to prepend to a system prompt. Every agent adapter (Anthropic,
 * and later OpenAI/Bedrock) calls this so retrieval + formatting live in one
 * place and never drift apart.
 */
export async function recallMemory(
  memory: MemoryStore,
  query: string,
  opts: RecallOptions = {},
): Promise<{ records: MemoryRecord[]; block: string }> {
  const records = query
    ? await memory.search(query, {
        k: opts.k ?? 6,
        minScore: opts.minScore,
        kind: opts.kind,
      })
    : [];
  return { records, block: formatMemoryBlock(records) };
}

/**
 * Model-agnostic persistence: save each non-empty fact and return the records.
 * Writes are always explicit — the caller decides what to persist — so nothing
 * lands in long-term memory behind the user's back.
 */
export async function rememberFacts(
  memory: MemoryStore,
  facts: string[],
  opts: { kind?: string } = {},
): Promise<MemoryRecord[]> {
  const out: MemoryRecord[] = [];
  for (const f of facts) {
    const text = f?.trim();
    if (!text) continue;
    out.push(await memory.save(text, { kind: opts.kind ?? "fact" }));
  }
  return out;
}
