import { describe, it, expect } from "vitest";
import {
  createMemoryStore,
  recallMemory,
  rememberFacts,
  formatMemoryBlock,
} from "../src/memory.ts";
import { runAgent } from "../src/anthropic.ts";
import type { AgentPart } from "../src/agent.ts";

describe("createMemoryStore", () => {
  it("saves and returns a record with an id", async () => {
    const m = createMemoryStore();
    const rec = await m.save("the sky is blue", { kind: "fact" });
    expect(rec.id).toBeTruthy();
    expect(rec.text).toBe("the sky is blue");
    expect(rec.kind).toBe("fact");
  });

  it("ranks more relevant records higher", async () => {
    const m = createMemoryStore();
    await m.save("user prefers dark mode in the editor");
    await m.save("the capital of France is Paris");
    const hits = await m.search("what editor theme does the user like", {
      k: 5,
    });
    expect(hits[0].text).toContain("dark mode");
    expect((hits[0].score ?? 0)).toBeGreaterThan(0);
  });

  it("respects k, kind filter, and empty queries", async () => {
    const m = createMemoryStore();
    await m.save("apple banana", { kind: "food" });
    await m.save("apple carrot", { kind: "food" });
    await m.save("apple widget", { kind: "other" });
    expect(await m.search("apple", { k: 1 })).toHaveLength(1);
    const food = await m.search("apple", { kind: "food" });
    expect(food.every((r) => r.kind === "food")).toBe(true);
    expect(await m.search("")).toEqual([]);
  });

  it("forgets by id", async () => {
    const m = createMemoryStore();
    const rec = await m.save("temporary");
    expect(await m.forget(rec.id)).toBe(true);
    expect(await m.forget("nope")).toBe(false);
    expect(await m.all?.()).toHaveLength(0);
  });

  it("preloads from seed", async () => {
    const m = createMemoryStore([
      { id: "a", text: "seeded fact about rockets" },
    ]);
    const hits = await m.search("rockets");
    expect(hits[0].id).toBe("a");
  });
});

describe("model-agnostic helpers", () => {
  it("recallMemory returns records plus a formatted block", async () => {
    const m = createMemoryStore();
    await m.save("user lives in Berlin");
    const { records, block } = await recallMemory(m, "where does the user live");
    expect(records.length).toBeGreaterThan(0);
    expect(block).toContain("Relevant memory");
    expect(block).toContain("Berlin");
  });

  it("recallMemory returns an empty block for no hits / empty query", async () => {
    const m = createMemoryStore();
    expect((await recallMemory(m, "")).block).toBe("");
    expect((await recallMemory(m, "nothing matches")).records).toEqual([]);
  });

  it("rememberFacts saves non-empty facts and skips blanks", async () => {
    const m = createMemoryStore();
    const saved = await rememberFacts(m, ["fact one", "  ", "", "fact two"]);
    expect(saved).toHaveLength(2);
    expect((await m.all?.())?.length).toBe(2);
  });

  it("formatMemoryBlock is empty for no records", () => {
    expect(formatMemoryBlock([])).toBe("");
  });
});

// ── Minimal stub of the Anthropic streaming client ──────────────────────────
// Each scripted turn yields text deltas then a finalMessage. `stop_reason` is
// "end_turn" so runAgent finishes after one turn (no tools in these tests).
function stubClient(turns: { text: string }[]) {
  let i = 0;
  return {
    messages: {
      stream() {
        const turn = turns[Math.min(i++, turns.length - 1)];
        const events = [
          {
            type: "content_block_delta" as const,
            delta: { type: "text_delta" as const, text: turn.text },
          },
        ];
        return {
          async *[Symbol.asyncIterator]() {
            for (const e of events) yield e;
          },
          async finalMessage() {
            return {
              content: [{ type: "text", text: turn.text }],
              stop_reason: "end_turn",
            };
          },
        };
      },
    },
  };
}

async function collect(gen: AsyncGenerator<AgentPart>): Promise<AgentPart[]> {
  const out: AgentPart[] = [];
  for await (const p of gen) out.push(p);
  return out;
}

describe("runAgent memory hooks", () => {
  it("recalls relevant memory and emits a recalled part", async () => {
    const memory = createMemoryStore();
    await memory.save("the user's name is Ada");

    const parts = await collect(
      runAgent({
        client: stubClient([{ text: "Hello Ada!" }]) as never,
        model: "test",
        tools: [],
        execute: async () => null,
        prompt: "what is my name?",
        memory,
        recall: { k: 3 },
      }),
    );

    const recalled = parts.find(
      (p) => p.type === "memory" && p.op === "recalled",
    );
    expect(recalled).toBeTruthy();
    expect(
      recalled?.type === "memory" && recalled.records[0].text,
    ).toContain("Ada");
    expect(parts.some((p) => p.type === "text")).toBe(true);
  });

  it("persists facts returned by an explicit remember function", async () => {
    const memory = createMemoryStore();
    const parts = await collect(
      runAgent({
        client: stubClient([{ text: "Got it." }]) as never,
        model: "test",
        tools: [],
        execute: async () => null,
        prompt: "I prefer TypeScript over JavaScript.",
        memory,
        // The caller decides what to persist — e.g. here, model-free extraction
        // from the user's message.
        remember: ({ messages }) => {
          const user = messages.find(
            (m) => m.role === "user" && typeof m.content === "string",
          );
          const text =
            user && typeof user.content === "string" ? user.content : "";
          return text ? [text] : [];
        },
      }),
    );

    const saved = parts.filter(
      (p) => p.type === "memory" && p.op === "saved",
    );
    expect(saved.length).toBeGreaterThan(0);
    const all = await memory.all?.();
    expect(all?.some((r) => /TypeScript/i.test(r.text))).toBe(true);
  });

  it("does nothing memory-related when no store is passed", async () => {
    const parts = await collect(
      runAgent({
        client: stubClient([{ text: "hi" }]) as never,
        model: "test",
        tools: [],
        execute: async () => null,
        prompt: "hello",
      }),
    );
    expect(parts.every((p) => p.type !== "memory")).toBe(true);
  });
});
