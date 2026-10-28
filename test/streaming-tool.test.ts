import { describe, it, expect } from "vitest";
import {
  initDendra,
  toToolset,
  createToolExecutor,
  createMcpBridge,
  createMcpToolSource,
  createApprovals,
  mergeToolsets,
  toToolSource,
  s,
  type RouterRecord,
} from "../src/index.ts";
import { runAgent } from "../src/anthropic.ts";

const { route } = initDendra();

const router = {
  // A streaming procedure, exposed as a tool.
  story: route
    .input(s.object({ topic: s.string() }))
    .ai({ description: "Tell a short story about a topic" })
    .stream(async function* ({ input }) {
      for (const word of ["once", "upon", input.topic]) yield word + " ";
    }),
  // A streaming procedure that yields non-strings → collected as an array.
  nums: route
    .input(s.object({ n: s.number() }))
    .ai({ description: "Emit numbers" })
    .stream(async function* ({ input }) {
      for (let i = 0; i < input.n; i++) yield i;
    }),
} satisfies RouterRecord;

describe("streaming tools (collected results)", () => {
  it("exposes streaming procedures as tools", () => {
    const tools = toToolset(router, { format: "plain" }) as Array<{ name: string }>;
    expect(tools.map((t) => t.name).sort()).toEqual(["nums", "story"]);
  });

  it("joins streamed string chunks into one result", async () => {
    const execute = createToolExecutor(router, {});
    expect(await execute("story", { topic: "dragons" })).toBe(
      "once upon dragons ",
    );
  });

  it("collects non-string chunks into an array", async () => {
    const execute = createToolExecutor(router, {});
    expect(await execute("nums", { n: 3 })).toEqual([0, 1, 2]);
  });
});

// A subscription exposed as a tool never ends on its own (#57): collection is
// bounded, the handler is stopped, and the caller can cancel.
describe("streaming tools that don't end", () => {
  const stopped = { count: 0 };
  // Yields `every` ms until its signal aborts — like a pub/sub watch.
  const ticker = (every: number) =>
    async function* ({ signal }: { signal: AbortSignal }) {
      try {
        for (let i = 0; !signal.aborted; i++) {
          yield i;
          await new Promise((r) => setTimeout(r, every));
        }
      } finally {
        stopped.count++;
      }
    };
  const r = {
    watch: route.ai({ timeoutMs: 50 }).stream(ticker(5)),
    firehose: route.ai({ maxItems: 3 }).stream(ticker(0)),
    defaults: route.ai().stream(ticker(0)),
    unary: route.ai().handler(() => new Promise<string>((res) => setTimeout(() => res("late"), 200))),
  } satisfies RouterRecord;

  it("answers with what arrived when timeoutMs passes, and stops the handler", async () => {
    stopped.count = 0;
    const out = (await createToolExecutor(r, {})("watch", undefined)) as number[];
    expect(out.length).toBeGreaterThan(0);
    expect(out.slice(0, 3)).toEqual([0, 1, 2]);
    await new Promise((res) => setTimeout(res, 20));
    expect(stopped.count).toBe(1);
  });

  it("stops at maxItems", async () => {
    expect(await createToolExecutor(r, {})("firehose", undefined)).toEqual([0, 1, 2]);
  });

  it("has a default bound of 1,000 chunks", async () => {
    expect(((await createToolExecutor(r, {})("defaults", undefined)) as number[]).length).toBe(1000);
  }, 10_000);

  it("cancels a stream with the call's signal, rejecting with its reason", async () => {
    stopped.count = 0;
    const ac = new AbortController();
    const call = createToolExecutor(r, {})("watch", undefined, { signal: ac.signal });
    setTimeout(() => ac.abort(new Error("user left")), 10);
    await expect(call).rejects.toThrow("user left");
    await new Promise((res) => setTimeout(res, 20));
    expect(stopped.count).toBe(1);
  });

  it("stops waiting for a unary tool when the signal aborts", async () => {
    const ac = new AbortController();
    const call = createToolExecutor(r, {})("unary", undefined, { signal: ac.signal });
    ac.abort(new Error("cancelled"));
    await expect(call).rejects.toThrow("cancelled");
  });

  it("refuses an already-aborted signal without running the tool", async () => {
    stopped.count = 0;
    await expect(
      createToolExecutor(r, {})("watch", undefined, { signal: AbortSignal.abort(new Error("gone")) }),
    ).rejects.toThrow("gone");
    expect(stopped.count).toBe(0);
  });

  it("rejects limits on a unary tool, and limits that aren't positive", () => {
    expect(() => route.ai({ timeoutMs: 10 }).handler(() => 1)).toThrow(/stream/);
    expect(() => route.ai({ maxItems: 0 })).toThrow(/maxItems/);
    expect(() => route.ai({ timeoutMs: -1 })).toThrow(/timeoutMs/);
  });

  it("mergeToolsets passes the signal through", async () => {
    const { execute } = mergeToolsets(toToolSource(r, {}, { format: "plain" }));
    const ac = new AbortController();
    const call = execute("watch", undefined, { signal: ac.signal });
    ac.abort(new Error("stop"));
    await expect(call).rejects.toThrow("stop");
  });

  it("bounds a streaming confirm tool on approval too", async () => {
    const c = { feed: route.ai({ confirm: true, maxItems: 2 }).stream(ticker(0)) } satisfies RouterRecord;
    const approvals = createApprovals(c);
    const { actionId } = (await createToolExecutor(c, {}, { approvals })("feed", undefined)) as {
      actionId: string;
    };
    expect(await approvals.approve(actionId, {})).toEqual([0, 1]);
  });
});

describe("cancelling tool calls from the outside", () => {
  const never = route.ai({ timeoutMs: 60_000 }).stream(async function* ({ signal }) {
    yield 0;
    await new Promise((r) => signal.addEventListener("abort", r));
  });
  const r = { never } satisfies RouterRecord;

  it("runAgent's signal cancels a tool call in flight and ends the run", async () => {
    const ac = new AbortController();
    const client = {
      messages: {
        stream() {
          return {
            async *[Symbol.asyncIterator]() {},
            async finalMessage() {
              setTimeout(() => ac.abort(new Error("run cancelled")), 10);
              return { content: [{ type: "tool_use", id: "t1", name: "never", input: {} }], stop_reason: "tool_use" };
            },
          };
        },
      },
    };
    const run = (async () => {
      for await (const _ of runAgent({
        client: client as never,
        model: "m",
        tools: [],
        execute: createToolExecutor(r, {}),
        prompt: "go",
        signal: ac.signal,
      }));
    })();
    await expect(run).rejects.toThrow("run cancelled");
  });

  it("the MCP bridge passes the request's signal to the tool", async () => {
    const ac = new AbortController();
    const call = createMcpBridge(r, {}).callTool("never", {}, { signal: ac.signal });
    setTimeout(() => ac.abort(new Error("client cancelled")), 10);
    await expect(call).rejects.toThrow("client cancelled");
  });

  it("an external MCP tool stops waiting when the signal aborts", async () => {
    const client = {
      listTools: async () => ({ tools: [{ name: "slow", inputSchema: { type: "object" } }] }),
      callTool: () => new Promise<never>(() => {}),
    };
    const source = await createMcpToolSource(client);
    const ac = new AbortController();
    const call = source.execute("slow", {}, { signal: ac.signal });
    ac.abort(new Error("gave up"));
    await expect(call).rejects.toThrow("gave up");
  });
});
