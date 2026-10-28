import { describe, it, expect } from "vitest";
import {
  initDendra,
  toFetchHandler,
  createClient,
  createMcpBridge,
  createWsSession,
  createWsClient,
  createToolExecutor,
  type RouterRecord,
} from "../src/index.ts";
import { runAgent } from "../src/anthropic.ts";

// `JSON.stringify(undefined)` is `undefined`, not JSON: an undefined value is
// sent as `null` wherever dendra encodes it (#64).

const { route } = initDendra();
const router = {
  gaps: route.stream(async function* () {
    yield 1;
    yield undefined;
    yield 2;
  }),
  nothing: route.ai().handler(() => undefined),
} satisfies RouterRecord;

const handler = toFetchHandler(router);
const fetchVia: typeof fetch = (input, init) => handler(new Request(input, init));

describe("undefined values", () => {
  for (const streamFormat of ["ndjson", "sse"] as const) {
    it(`a stream yielding undefined arrives as null (${streamFormat})`, async () => {
      const api = createClient<typeof router>("http://x", { fetch: fetchVia, streamFormat });
      const got: unknown[] = [];
      for await (const v of api.gaps()) got.push(v);
      expect(got).toEqual([1, null, 2]);
    });
  }

  it("a stream yielding undefined arrives as null (WebSocket)", async () => {
    const client = createWsClient<typeof router>((d) => queueMicrotask(() => session.handleMessage(d)));
    const session = createWsSession(router, (d) => queueMicrotask(() => client.receive(d)));
    const got: unknown[] = [];
    for await (const v of client.api.gaps()) got.push(v);
    expect(got).toEqual([1, null, 2]);
  });

  it("the MCP bridge sends valid text for a tool that returns undefined", async () => {
    const res = await createMcpBridge(router, {}).callTool("nothing", {});
    expect(res.content).toEqual([{ type: "text", text: "null" }]);
    expect(res.isError).toBeFalsy();
  });

  it("runAgent sends the model null for a tool that returns undefined", async () => {
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
                ? { content: [{ type: "tool_use", id: "t1", name: "nothing", input: {} }], stop_reason: "tool_use" }
                : { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" };
            },
          };
        },
      },
    };
    const execute = createToolExecutor(router, {});
    for await (const _ of runAgent({ client: client as never, model: "m", tools: [], execute, prompt: "go" }));
    expect(sent[1]).toMatchObject({ content: [{ type: "tool_result", tool_use_id: "t1", content: "null" }] });
  });
});
