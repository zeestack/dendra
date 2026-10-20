import { describe, it, expect } from "vitest";
import {
  initDendra,
  toFetchHandler,
  createClient,
  DendraClientError,
  DendraError,
  s,
  type RouterRecord,
} from "../src/index.ts";

const { route } = initDendra();
const appRouter = {
  add: route
    .input(s.object({ a: s.number(), b: s.number() }))
    .handler(({ input }) => input.a + input.b),
  double: route
    .input(s.object({ n: s.number() }))
    .handler(({ input }) => input.n * 2),
} satisfies RouterRecord;
type App = typeof appRouter;

describe("request batching", () => {
  it("collects same-tick unary calls into one __batch request", async () => {
    const handler = toFetchHandler(appRouter);
    let httpCalls = 0;
    const countingFetch = ((input: string | URL | Request, init?: RequestInit) => {
      httpCalls++;
      return handler(new Request(String(input), init));
    }) as typeof fetch;

    const api = createClient<App>("http://local", {
      fetch: countingFetch,
      batch: true,
    });

    // Three calls in the same tick → one HTTP request.
    const [a, b, c] = await Promise.all([
      api.add({ a: 1, b: 2 }),
      api.double({ n: 10 }),
      api.add({ a: 5, b: 5 }),
    ]);

    expect([a, b, c]).toEqual([3, 20, 10]);
    expect(httpCalls).toBe(1); // batched
  });

  it("surfaces per-call errors within a batch", async () => {
    const handler = toFetchHandler(appRouter);
    const api = createClient<App>("http://local", {
      fetch: ((i: string | URL | Request, init?: RequestInit) =>
        handler(new Request(String(i), init))) as typeof fetch,
      batch: true,
    });

    const ok = api.add({ a: 2, b: 3 });
    const bad = api.add({ a: 1, b: "x" as unknown as number });

    expect(await ok).toBe(5);
    await expect(bad).rejects.toBeInstanceOf(DendraClientError);
  });
});

describe("batching doesn't hold calls back (#9)", () => {
  const slowRouter = {
    ...appRouter,
    slow: route.handler(
      () => new Promise<string>((r) => setTimeout(() => r("slow"), 200)),
    ),
  } satisfies RouterRecord;
  type Slow = typeof slowRouter;

  function setup(rewrite?: (init: RequestInit) => RequestInit) {
    const handler = toFetchHandler(slowRouter);
    const urls: string[] = [];
    const api = createClient<Slow>("http://local", {
      batch: true,
      fetch: ((i: string | URL | Request, init?: RequestInit) => {
        urls.push(String(i));
        return handler(new Request(String(i), rewrite ? rewrite(init!) : init));
      }) as typeof fetch,
    });
    return { api, urls };
  }

  it("resolves a quick call without waiting for a slow one in the same batch", async () => {
    const { api, urls } = setup();
    const slow = api.slow().then((v) => v); // .then sends it (calls are lazy)
    const t0 = Date.now();
    expect(await api.add({ a: 1, b: 1 })).toBe(2);
    expect(Date.now() - t0).toBeLessThan(150);
    expect(await slow).toBe("slow");
    expect(urls).toHaveLength(1);
  });

  it("batches .then() and await calls from the same tick together", async () => {
    const { api, urls } = setup();
    const a = api.add({ a: 1, b: 1 }).then((v) => v);
    const b = await api.double({ n: 2 });
    expect([await a, b]).toEqual([2, 4]);
    expect(urls).toHaveLength(1);
  });

  it("names the batched procedures in the URL", async () => {
    const { api, urls } = setup();
    await Promise.all([api.add({ a: 1, b: 2 }), api.double({ n: 1 })]);
    expect(new URL(urls[0]).pathname).toBe("/rpc/__batch");
    expect(new URL(urls[0]).searchParams.get("p")).toBe("add,double");
  });

  it("lets a call opt out with { batch: false }", async () => {
    const { api, urls } = setup();
    await Promise.all([
      api.add({ a: 1, b: 2 }),
      api.double({ n: 1 }, { batch: false }),
    ]);
    expect(urls.map((u) => new URL(u).pathname).sort()).toEqual([
      "/rpc/__batch",
      "/rpc/double",
    ]);
  });

  it("still answers an older client (no NDJSON Accept) with a JSON array", async () => {
    const res = await toFetchHandler(appRouter)(
      new Request("http://x/rpc/__batch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify([
          { path: "add", input: { a: 1, b: 2 } },
          { path: "double", input: { n: 4 } },
        ]),
      }),
    );
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual([{ result: 3 }, { result: 8 }]);
  });

  it("still understands an older server's JSON array", async () => {
    // Dropping the Accept header makes the server answer the old way.
    const { api } = setup((init) => {
      const headers = { ...(init.headers as Record<string, string>) };
      delete headers.accept;
      return { ...init, headers };
    });
    const [a, b] = await Promise.all([api.add({ a: 2, b: 2 }), api.double({ n: 3 })]);
    expect([a, b]).toEqual([4, 6]);
  });
});

describe("a batch the server rejects as a whole", () => {
  it("rejects every call with the server's error", async () => {
    const handler = toFetchHandler(appRouter, {
      createContext: () => {
        throw new DendraError("UNAUTHORIZED", "Sign in");
      },
    });
    const api = createClient<App>("http://local", {
      batch: true,
      fetch: ((i: string | URL | Request, init?: RequestInit) =>
        handler(new Request(String(i), init))) as typeof fetch,
    });
    const results = await Promise.allSettled([api.add({ a: 1, b: 1 }), api.double({ n: 1 })]);
    for (const r of results) {
      expect(r.status).toBe("rejected");
      expect((r as PromiseRejectedResult).reason).toMatchObject({ code: "UNAUTHORIZED" });
    }
  });
});
