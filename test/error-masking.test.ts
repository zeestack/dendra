import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  initDendra,
  s,
  toFetchHandler,
  createWsSession,
  createWsClient,
  createMcpBridge,
  createMcpToolSource,
  createToolExecutor,
  createJobs,
  createInMemoryJobStore,
  createInMemoryPubSub,
  lazyToolset,
  DendraError,
  type RouterRecord,
} from "../src/index.ts";
import { runAgent } from "../src/anthropic.ts";

// An unexpected error's message can carry internals; callers (browsers, the
// model) get a bare INTERNAL, and the original is logged. A DendraError is the
// app's deliberate message and passes through.
const SECRET = "connect ECONNREFUSED postgres://admin:hunter2@10.0.0.5/prod";
const { route } = initDendra();
const router = {
  boom: route.ai({ description: "fails" }).handler(() => {
    throw new Error(SECRET);
  }),
  denied: route.ai({ description: "refuses" }).handler(() => {
    throw new DendraError("FORBIDDEN", "Not your note");
  }),
  feed: route.stream(async function* () {
    yield 1;
    throw new Error(SECRET);
  }),
  secret: route.handler(() => "not a tool"),
} satisfies RouterRecord;

let logged: unknown[][];
beforeEach(() => {
  logged = [];
  vi.spyOn(console, "error").mockImplementation((...args) => void logged.push(args));
});
afterEach(() => vi.restoreAllMocks());
const loggedSecret = () => logged.some((args) => args.some((a) => a instanceof Error && a.message === SECRET));

const handler = toFetchHandler(router);
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  handler(
    new Request(`http://x/rpc/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );

describe("unexpected errors are masked", () => {
  it("over HTTP, and logged", async () => {
    const res = await post("boom", {});
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { code: "INTERNAL", message: "Internal error" } });
    expect(loggedSecret()).toBe(true);
  });

  it("but a DendraError's message passes through", async () => {
    const res = await post("denied", {});
    expect(await res.json()).toEqual({ error: { code: "FORBIDDEN", message: "Not your note" } });
    expect(logged).toEqual([]);
  });

  it("in NDJSON and SSE streams", async () => {
    const ndjson = await (await post("feed", {})).text();
    const sse = await (await post("feed", {}, { accept: "text/event-stream" })).text();
    for (const body of [ndjson, sse]) {
      expect(body).not.toContain("hunter2");
      expect(body).toContain("Internal error");
    }
  });

  it("over a WebSocket session", async () => {
    const client = createWsClient<typeof router>((d) => queueMicrotask(() => session.handleMessage(d)));
    const session = createWsSession(router, (d) => queueMicrotask(() => client.receive(d)), {});
    await expect(client.api.boom()).rejects.toMatchObject({ code: "INTERNAL", message: "Internal error" });
    expect(loggedSecret()).toBe(true);
  });

  it("in a failed job's snapshot", async () => {
    const jobs = createJobs({
      store: createInMemoryJobStore(),
      pubsub: createInMemoryPubSub(),
      context: () => ({}),
      onError: () => {},
    });
    const job = jobs.define("leaky", {
      retries: 0,
      run: () => {
        throw new Error(SECRET);
      },
    });
    const { jobId } = await job.enqueue(undefined);
    jobs.start();
    try {
      for (let i = 0; i < 400 && (await job.get(jobId))?.status !== "failed"; i++) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect((await job.get(jobId))?.error).toEqual({ code: "INTERNAL", message: "Internal error" });
    } finally {
      await jobs.stop();
    }
  });

  it("from the MCP bridge", async () => {
    const mcp = createMcpBridge(router, {});
    expect(await mcp.callTool("boom", {})).toEqual({
      content: [{ type: "text", text: "Internal error" }],
      isError: true,
    });
    expect(await mcp.callTool("denied", {})).toMatchObject({ content: [{ text: "Not your note" }] });
    expect(loggedSecret()).toBe(true);
  });

  it("from runAgent's tool results", async () => {
    let turn = 0;
    const sent: unknown[] = [];
    const client = {
      messages: {
        stream(req: { messages: unknown[] }) {
          sent.push(structuredClone(req.messages.at(-1)));
          const first = turn++ === 0;
          return {
            async *[Symbol.asyncIterator]() {},
            async finalMessage() {
              return first
                ? { content: [{ type: "tool_use", id: "t1", name: "boom", input: {} }], stop_reason: "tool_use" }
                : { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" };
            },
          };
        },
      },
    };
    const execute = createToolExecutor(router, {});
    for await (const _ of runAgent({ client: client as never, model: "m", tools: [], execute, prompt: "go" }));
    expect(JSON.stringify(sent)).not.toContain("hunter2");
    expect(JSON.stringify(sent)).toContain("Internal error");
    expect(loggedSecret()).toBe(true);
  });
});

describe("tool exposure", () => {
  it("answers the same for a missing tool and one without .ai()", async () => {
    const execute = createToolExecutor(router, {});
    await expect(execute("secret", {})).rejects.toMatchObject({ code: "NOT_FOUND", message: "Tool 'secret' not found" });
    await expect(execute("nope", {})).rejects.toMatchObject({ code: "NOT_FOUND", message: "Tool 'nope' not found" });
  });

  it("an external MCP tool's error text reaches the model as BAD_GATEWAY", async () => {
    const source = await createMcpToolSource({
      listTools: async () => ({ tools: [{ name: "search" }] }),
      callTool: async () => ({ content: [{ type: "text", text: "rate limited" }], isError: true }),
    });
    await expect(source.execute("search", {})).rejects.toMatchObject({ code: "BAD_GATEWAY", message: "rate limited" });
  });

  it("tool names can't walk the prototype chain", async () => {
    const execute = createToolExecutor(router, {});
    for (const name of ["__proto__", "constructor", "boom.constructor", "__proto__.toString", "hasOwnProperty"]) {
      await expect(execute(name, {})).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
  });

  it("the executor itself only throws DendraErrors, for hand-written loops", async () => {
    const execute = createToolExecutor(router, {});
    await expect(execute("boom", {})).rejects.toMatchObject({ code: "INTERNAL", message: "Internal error" });
    await expect(execute("denied", {})).rejects.toMatchObject({ code: "FORBIDDEN", message: "Not your note" });
    expect(loggedSecret()).toBe(true);
  });

  it("lazyToolset rejects two tools that sanitize to the same name", () => {
    const tool = (name: string) => ({ name, description: name, input_schema: { type: "object" } });
    expect(() => lazyToolset([tool("posts.delete"), tool("posts_delete")])).toThrow(/both become 'posts_delete'/);
  });
});
