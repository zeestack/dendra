import { describe, it, expect } from "vitest";
import {
  initDendra,
  toFetchHandler,
  toRestHandler,
  createClient,
  createInMemoryPubSub,
  DendraError,
  DendraClientError,
  type RouterRecord,
  type ServerOptions,
} from "../src/index.ts";

const { route } = initDendra();

function makeRouter() {
  const pubsub = createInMemoryPubSub();
  const state = { aborted: false, cleanedUp: false };
  const router = {
    count: route.stream(async function* () {
      yield 1;
      yield { two: 2 };
      yield "line\nbreak";
    }),
    fails: route.stream(async function* () {
      yield "first";
      throw new DendraError("FORBIDDEN", "nope");
    }),
    watch: route.get("/watch").stream(async function* ({ signal }) {
      signal.addEventListener("abort", () => (state.aborted = true));
      try {
        yield "ready";
        for await (const m of pubsub.subscribe("t", { signal })) yield m;
      } finally {
        state.cleanedUp = true;
      }
    }),
  } satisfies RouterRecord;
  return { router, state, pubsub };
}

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

function sseRequest(path: string): Request {
  return new Request("http://x/rpc/" + path, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: "null",
  });
}

function client(router: object, opts: ServerOptions<unknown> = {}) {
  const handler = toFetchHandler(router, opts);
  return createClient<ReturnType<typeof makeRouter>["router"]>("http://local", {
    streamFormat: "sse",
    fetch: ((i: string | URL | Request, init?: RequestInit) =>
      handler(new Request(String(i), init))) as typeof fetch,
  });
}

describe("SSE: server", () => {
  it("answers Accept: text/event-stream with data events and a done event", async () => {
    const { router } = makeRouter();
    const res = await toFetchHandler(router)(sseRequest("count"));
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(res.headers.get("x-accel-buffering")).toBe("no");
    expect(await res.text()).toBe(
      'data: 1\n\ndata: {"two":2}\n\ndata: "line\\nbreak"\n\nevent: done\ndata: null\n\n',
    );
  });

  it("still answers NDJSON by default", async () => {
    const { router } = makeRouter();
    const res = await toFetchHandler(router)(
      new Request("http://x/rpc/count", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "null",
      }),
    );
    expect(res.headers.get("content-type")).toBe("application/x-ndjson");
    expect(await res.text()).toBe('1\n{"two":2}\n"line\\nbreak"\n');
  });

  it("sends a failure as an error event", async () => {
    const { router } = makeRouter();
    const res = await toFetchHandler(router)(sseRequest("fails"));
    expect(await res.text()).toBe(
      'data: "first"\n\nevent: error\ndata: {"code":"FORBIDDEN","message":"nope"}\n\n',
    );
  });

  it("sends ping comments while idle, and stops on cancel", async () => {
    const { router, state } = makeRouter();
    const res = await toFetchHandler(router, { heartbeatMs: 5 })(sseRequest("watch"));
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let text = "";
    while (!text.includes(": ping")) text += dec.decode((await reader.read()).value);
    expect(text.startsWith('data: "ready"\n\n')).toBe(true);
    await reader.cancel();
    await tick();
    expect(state).toEqual({ aborted: true, cleanedUp: true });
  });

  it("heartbeatMs: 0 turns pings off", async () => {
    const { router, pubsub } = makeRouter();
    const res = await toFetchHandler(router, { heartbeatMs: 0 })(sseRequest("watch"));
    const reader = res.body!.getReader();
    await reader.read();
    await tick(30);
    await pubsub.publish("t", "next");
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toBe('data: "next"\n\n');
    await reader.cancel();
  });

  it("serves a .get() stream over REST for an EventSource", async () => {
    const { router, state } = makeRouter();
    const res = await toRestHandler(router)(
      new Request("http://x/watch", { headers: { accept: "text/event-stream" } }),
    );
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const reader = res.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: "ready"\n\n');
    await reader.cancel();
    await tick();
    expect(state.cleanedUp).toBe(true);
  });
});

describe("SSE: client", () => {
  it("iterates values and ends on done", async () => {
    const { router } = makeRouter();
    const got: unknown[] = [];
    for await (const v of client(router).count()) got.push(v);
    expect(got).toEqual([1, { two: 2 }, "line\nbreak"]);
  });

  it("throws a typed DendraClientError from an error event", async () => {
    const { router } = makeRouter();
    const got: unknown[] = [];
    const err = await (async () => {
      for await (const v of client(router).fails()) got.push(v);
    })().catch((e: unknown) => e);
    expect(got).toEqual(["first"]);
    expect(err).toBeInstanceOf(DendraClientError);
    expect(err).toMatchObject({ code: "FORBIDDEN", message: "nope" });
  });

  it("breaking out of the loop stops the server handler", async () => {
    const { router, state } = makeRouter();
    for await (const v of client(router).watch()) {
      expect(v).toBe("ready");
      break;
    }
    await tick();
    expect(state).toEqual({ aborted: true, cleanedUp: true });
  });

  it("skips heartbeats", async () => {
    const { router, pubsub } = makeRouter();
    const got: unknown[] = [];
    for await (const v of client(router, { heartbeatMs: 2 }).watch()) {
      got.push(v);
      if (got.length === 1) setTimeout(() => void pubsub.publish("t", "later"), 20);
      else break;
    }
    expect(got).toEqual(["ready", "later"]);
  });

  it("throws the JSON error a request fails with before streaming", async () => {
    const { router } = makeRouter();
    const api = client(router, {
      createContext: () => {
        throw new DendraError("UNAUTHORIZED", "sign in");
      },
    });
    await expect(
      (async () => {
        for await (const _ of api.count()) void _;
      })(),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED", message: "sign in" });
  });
});
