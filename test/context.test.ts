import { describe, it, expect } from "vitest";
import { lazyToolset } from "../src/context.ts";
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
  {
    name: "invoices.send",
    description: "Send an invoice to a customer",
    input_schema: { type: "object", properties: { id: { type: "string" } } },
  },
];

describe("lazyToolset", () => {
  it("defers all tools behind a single search_tools meta-tool", () => {
    const lazy = lazyToolset(TOOLS);
    expect(lazy.tools).toHaveLength(1);
    expect((lazy.tools[0] as { name: string }).name).toBe("search_tools");
    expect(lazy.metaName).toBe("search_tools");
    // menu lists the deferred tools with sanitized names
    expect(lazy.menu).toContain("notes_create");
    expect(lazy.menu).toContain("weather_get");
  });

  it("maps sanitized names back to the originals", () => {
    const lazy = lazyToolset(TOOLS);
    expect(lazy.nameMap.get("notes_create")).toBe("notes.create");
    expect(lazy.nameMap.get("weather_get")).toBe("weather.get");
    expect(lazy.nameMap.get("search_tools")).toBe("search_tools");
  });

  it("search loads the matching tool, with sanitized names, once", () => {
    const lazy = lazyToolset(TOOLS);
    const first = lazy.handle("search_tools", { query: "create a note" });
    expect(first).not.toBeNull();
    const found = (first!.result as { found: { name: string }[] }).found;
    expect(found[0].name).toBe("notes_create");
    expect((first!.loaded[0] as { name: string }).name).toBe("notes_create");

    // Searching again for the same tool doesn't re-load it.
    const second = lazy.handle("search_tools", { query: "note" });
    expect(second!.loaded).toHaveLength(0);
  });

  it("returns null for a non-meta tool call", () => {
    const lazy = lazyToolset(TOOLS);
    expect(lazy.handle("notes_create", { title: "x" })).toBeNull();
  });

  it("honors pin (keeps a tool loaded, out of the menu)", () => {
    const lazy = lazyToolset(TOOLS, { pin: ["weather.get"] });
    const names = (lazy.tools as { name: string }[]).map((t) => t.name);
    expect(names).toContain("search_tools");
    expect(names).toContain("weather_get");
    expect(lazy.menu).not.toContain("weather_get");
  });
});

// Scripted Anthropic stub: each turn returns text and/or tool_use blocks. Records
// the tool names sent on every step so we can assert the live set grows.
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

describe("runAgent with lazyToolset", () => {
  it("searches, loads the tool into the live set, then calls it", async () => {
    const lazy = lazyToolset(TOOLS);
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
        lazyToolset: lazy,
      }),
    );

    // Step 1 sent only the meta-tool; step 2 had the loaded tool.
    expect(sentTools[0]).toEqual(["search_tools"]);
    expect(sentTools[1]).toContain("notes_create");

    // The executor was called with the ORIGINAL dotted name, not the sanitized one.
    expect(executed).toEqual(["notes.create"]);

    // Parts: a search_tools part, a notes.create tool part, and the final text.
    const toolNames = parts
      .filter((p): p is Extract<AgentPart, { type: "tool" }> => p.type === "tool")
      .map((p) => p.name);
    expect(toolNames).toContain("search_tools");
    expect(toolNames).toContain("notes.create");
    expect(parts.some((p) => p.type === "text" && p.text === "Done.")).toBe(true);
  });
});
