import { describe, it, expect } from "vitest";
import {
  initDendra,
  toFetchHandler,
  toRestHandler,
  createClient,
  createCaller,
  createInMemoryPubSub,
  s,
  type RouterRecord,
} from "../src/index.ts";

const { route } = initDendra();

// A subscription that yields once, then waits on pub/sub until told to stop —
// the shape that leaked before: nothing is ever written again, so the server
// never noticed the client had gone.
function makeRouter() {
  const pubsub = createInMemoryPubSub();
  const state = { aborted: false, cleanedUp: false };
  const router = {
    watch: route.get("/watch").stream(async function* ({ signal }) {
      const seen = () => (state.aborted ||= signal.aborted);
      seen();
      signal.addEventListener("abort", seen);
      try {
        yield "ready";
        for await (const m of pubsub.subscribe("t", { signal })) yield m;
      } finally {
        state.cleanedUp = true;
      }
    }),
    slow: route
      .input(s.object({ ms: s.number() }))
      .handler(({ input }) => new Promise((r) => setTimeout(() => r("done"), input.ms))),
  } satisfies RouterRecord;
  return { router, state };
}

const tick = () => new Promise((r) => setTimeout(r, 10));

async function readFirstLine(res: Response): Promise<ReadableStreamDefaultReader<Uint8Array>> {
  const reader = res.body!.getReader();
  await reader.read();
  return reader;
}

describe("server notices a closed client (#5b)", () => {
  it("RPC: cancelling the response aborts the handler and runs its finally", async () => {
    const { router, state } = makeRouter();
    const res = await toFetchHandler(router)(
      new Request("http://x/rpc/watch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "null",
      }),
    );
    const reader = await readFirstLine(res);
    await reader.cancel();
    await tick();
    expect(state).toEqual({ aborted: true, cleanedUp: true });
  });

  it("REST: cancelling the response aborts the handler", async () => {
    const { router, state } = makeRouter();
    const res = await toRestHandler(router)(new Request("http://x/watch"));
    const reader = await readFirstLine(res);
    await reader.cancel();
    await tick();
    expect(state).toEqual({ aborted: true, cleanedUp: true });
  });

  it("an aborted request signal aborts the handler", async () => {
    const { router, state } = makeRouter();
    const ac = new AbortController();
    const res = await toFetchHandler(router)(
      new Request("http://x/rpc/watch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "null",
        signal: ac.signal,
      }),
    );
    await readFirstLine(res);
    ac.abort();
    await tick();
    expect(state.aborted).toBe(true);
  });
});

describe("client abort (#5a)", () => {
  function client(router: object) {
    const handler = toFetchHandler(router);
    return createClient<ReturnType<typeof makeRouter>["router"]>("http://local", {
      fetch: ((i: string | URL | Request, init?: RequestInit) =>
        handler(new Request(String(i), init))) as typeof fetch,
    });
  }

  it("aborting a stream ends the for-await with the abort reason and stops the server", async () => {
    const { router, state } = makeRouter();
    const api = client(router);
    const ac = new AbortController();
    const got: unknown[] = [];
    const err = await (async () => {
      for await (const m of api.watch(undefined, { signal: ac.signal })) {
        got.push(m);
        setTimeout(() => ac.abort(), 0);
      }
    })().catch((e: unknown) => e);
    expect(got).toEqual(["ready"]);
    expect((err as Error).name).toBe("AbortError");
    await tick();
    expect(state).toEqual({ aborted: true, cleanedUp: true });
  });

  it("aborting a unary call rejects it", async () => {
    const { router } = makeRouter();
    const api = client(router);
    const ac = new AbortController();
    const call = api.slow({ ms: 50 }, { signal: ac.signal });
    setTimeout(() => ac.abort(), 0);
    await expect(call).rejects.toMatchObject({ name: "AbortError" });
  });

  it("an already-aborted signal rejects without sending", async () => {
    const { router } = makeRouter();
    let sent = 0;
    const handler = toFetchHandler(router);
    const api = createClient<typeof router>("http://local", {
      fetch: ((i: string | URL | Request, init?: RequestInit) => {
        sent++;
        return handler(new Request(String(i), init));
      }) as typeof fetch,
      batch: true,
    });
    await expect(
      api.slow({ ms: 1 }, { signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(sent).toBe(0);
  });
});

describe("caller abort", () => {
  it("passes the signal through to stream handlers", async () => {
    const { router, state } = makeRouter();
    const caller = createCaller(router);
    const ac = new AbortController();
    const err = await (async () => {
      for await (const _ of caller.watch(undefined, { signal: ac.signal })) {
        setTimeout(() => ac.abort(), 0);
      }
    })().catch((e: unknown) => e);
    // Same contract as the HTTP client: the loop throws the abort reason.
    expect((err as Error).name).toBe("AbortError");
    expect(state).toEqual({ aborted: true, cleanedUp: true });
  });

  it("rejects a unary call whose signal is already aborted", async () => {
    const { router } = makeRouter();
    await expect(
      createCaller(router).slow({ ms: 1 }, { signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("toNodeHandler", () => {
  async function serve(router: object) {
    const { createServer } = await import("node:http");
    const { toNodeHandler } = await import("../src/index.ts");
    const srv = createServer(toNodeHandler(router));
    await new Promise<void>((r) => srv.listen(0, r));
    const { port } = srv.address() as { port: number };
    return { url: `http://localhost:${port}/rpc/`, close: () => srv.close() };
  }

  it("keeps a stream open after the request body is read", async () => {
    const { router, state } = makeRouter();
    const { url, close } = await serve(router);
    try {
      const res = await fetch(url + "watch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "null",
      });
      const reader = await readFirstLine(res);
      await new Promise((r) => setTimeout(r, 50));
      expect(state.aborted).toBe(false);
      await reader.cancel();
    } finally {
      close();
    }
  });

  it("aborts the handler when the client disconnects", async () => {
    const { router, state } = makeRouter();
    const { url, close } = await serve(router);
    try {
      const ac = new AbortController();
      const res = await fetch(url + "watch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "null",
        signal: ac.signal,
      });
      await readFirstLine(res);
      ac.abort();
      await new Promise((r) => setTimeout(r, 50));
      expect(state).toEqual({ aborted: true, cleanedUp: true });
    } finally {
      close();
    }
  });
});
