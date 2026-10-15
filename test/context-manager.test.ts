import { describe, it, expect } from "vitest";
import {
  createContextManager,
  memorySource,
  toolSource,
  createMemoryStore,
} from "../src/index.ts";
import { runAgent } from "../src/anthropic.ts";
import type { AgentPart } from "../src/agent.ts";

const TOOLS = [
  {
    name: "notes.create",
    description: "Create a note with a title and body",
    input_schema: { type: "object", properties: { title: { type: "string" } } },
  },
  {
    name: "weather.get",
    description: "Get the current weather for a city",
    input_schema: { type: "object", properties: { city: { type: "string" } } },
  },
];

const len = (t: string) => t.length; // simplest token counter for tests

describe("createContextManager — prepare", () => {
  it("merges tool + memory sources: meta-tool, menu, recall, name map", async () => {
    const mem = createMemoryStore([
      { id: "1", text: "The user wants notes created with a Groceries tag" },
    ]);
    const cm = createContextManager({
      budget: { maxTokens: 100_000, count: len },
      sources: [toolSource(TOOLS), memorySource(mem, { recall: { k: 3 } })],
    });

    const prep = await cm.prepare({
      messages: [{ role: "user", content: "create a note" }],
      lastUserText: "create a note",
    });

    // tool source owns the list; only the meta-tool is exposed up front
    expect(prep.ownsTools).toBe(true);
    expect((prep.tools[0] as { name: string }).name).toBe("search_tools");
    expect(prep.metaNames.has("search_tools")).toBe(true);
    expect(prep.nameMap.get("notes_create")).toBe("notes.create");

    // deferred-tool menu + recalled memory both land in the system text
    expect(prep.system).toContain("notes_create");
    expect(prep.system).toContain("Groceries");

    // recalled memory is surfaced for a context part
    const memSel = prep.selected.find((s) => s.source === "memory");
    expect(memSel?.loaded.records).toHaveLength(1);
  });

  it("respects the token budget: skips recall when there's no room", async () => {
    const mem = createMemoryStore([
      { id: "1", text: "create a note titled anything you like" },
    ]);
    const cm = createContextManager({
      budget: { maxTokens: 5, count: len }, // tiny — the conversation alone blows it
      sources: [memorySource(mem, { recall: { k: 3 } })],
    });
    const prep = await cm.prepare({
      messages: [{ role: "user", content: "create a note" }],
      lastUserText: "create a note",
    });
    expect(prep.selected.find((s) => s.source === "memory")).toBeUndefined();
    expect(prep.system).toBe("");
  });

  it("without a tool source, the caller's own tools stay (ownsTools = false)", async () => {
    const mem = createMemoryStore();
    const cm = createContextManager({
      budget: { maxTokens: 100_000, count: len },
      sources: [memorySource(mem)],
    });
    const prep = await cm.prepare({ messages: [], lastUserText: "" });
    expect(prep.ownsTools).toBe(false);
    expect(prep.tools).toHaveLength(0);
  });
});

describe("createContextManager — handle & commit", () => {
  it("routes a search_tools call to the tool source", async () => {
    const cm = createContextManager({
      budget: { maxTokens: 100_000, count: len },
      sources: [toolSource(TOOLS)],
    });
    const h = cm.handle("search_tools", { query: "create a note" }, {
      messages: [],
      lastUserText: "",
    });
    expect(h?.source).toBe("tools");
    expect((h?.loaded.tools?.[0] as { name: string }).name).toBe("notes_create");
  });

  it("commit saves whatever remember() returns", async () => {
    const mem = createMemoryStore();
    const cm = createContextManager({
      budget: { maxTokens: 100_000, count: len },
      sources: [
        memorySource(mem, { remember: async () => ["remember this fact"] }),
      ],
    });
    const committed = await cm.commit({
      messages: [],
      lastUserText: "",
      assistantText: "done",
    });
    expect(committed[0]?.source).toBe("memory");
    expect(committed[0]?.loaded.records?.[0]?.text).toBe("remember this fact");
    expect(await mem.all!()).toHaveLength(1);
  });

  it("compact is identity unless a history hook is supplied", async () => {
    const cm = createContextManager({
      budget: { maxTokens: 100, count: len },
      sources: [],
    });
    const msgs = [{ role: "user", content: "a" }];
    expect(await cm.compact(msgs)).toBe(msgs);

    const cm2 = createContextManager({
      budget: { maxTokens: 100, count: len },
      sources: [],
      history: { compact: (m) => m.slice(-1) },
    });
    expect(await cm2.compact([1, 2, 3])).toEqual([3]);
  });
});

// Scripted Anthropic stub (same shape as context.test.ts).
function toolStub(
  turns: { text?: string; tools?: { id: string; name: string; input: unknown }[] }[],
  sentTools: string[][],
) {
  let i = 0;
  return {
    messages: {
      stream(req: { tools?: { name: string }[] }) {
        sentTools.push((req.tools ?? []).map((t) => t.name));
        const turn = turns[Math.min(i++, turns.length - 1)];
        const content: unknown[] = [];
        if (turn.text) content.push({ type: "text", text: turn.text });
        for (const t of turn.tools ?? [])
          content.push({ type: "tool_use", id: t.id, name: t.name, input: t.input });
        const stop_reason = turn.tools?.length ? "tool_use" : "end_turn";
        return {
          async *[Symbol.asyncIterator]() {
            if (turn.text)
              yield {
                type: "content_block_delta",
                delta: { type: "text_delta", text: turn.text },
              };
          },
          async finalMessage() {
            return { content, stop_reason };
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

describe("runAgent with a ContextManager", () => {
  it("recalls memory, loads a tool via search_tools, calls it, then saves", async () => {
    const mem = createMemoryStore([
      { id: "1", text: "The user keeps a Groceries note" },
    ]);
    const cm = createContextManager({
      budget: { maxTokens: 100_000, count: len },
      sources: [
        toolSource(TOOLS),
        memorySource(mem, {
          recall: { k: 3 },
          remember: async () => ["Made a Groceries note"],
        }),
      ],
    });
    const sentTools: string[][] = [];
    const executed: string[] = [];

    const parts = await collect(
      runAgent({
        client: toolStub(
          [
            { tools: [{ id: "a", name: "search_tools", input: { query: "create a note" } }] },
            { tools: [{ id: "b", name: "notes_create", input: { title: "Groceries" } }] },
            { text: "Done." },
          ],
          sentTools,
        ) as never,
        model: "test",
        tools: [],
        execute: async (name) => {
          executed.push(name);
          return { ran: name };
        },
        prompt: "make a note called Groceries",
        context: cm,
      }),
    );

    // Memory recalled before the model ran.
    const recalled = parts.find(
      (p) => p.type === "context" && p.op === "recalled",
    );
    expect(recalled).toBeTruthy();

    // search_tools loaded notes.create into the live set (step 2 sent it).
    expect(sentTools[0]).toEqual(["search_tools"]);
    expect(sentTools[1]).toContain("notes_create");
    const loaded = parts.find((p) => p.type === "context" && p.op === "loaded");
    expect(loaded && "tools" in loaded && loaded.tools).toContain("notes.create");

    // The real tool ran with the ORIGINAL dotted name.
    expect(executed).toEqual(["notes.create"]);

    // A memory write-back was saved and surfaced.
    const saved = parts.find((p) => p.type === "context" && p.op === "saved");
    expect(saved).toBeTruthy();
    expect((await mem.all!()).some((r) => r.text === "Made a Groceries note")).toBe(
      true,
    );
  });
});
