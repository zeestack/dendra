import { describe, it, expect } from "vitest";
import {
  initDendra,
  toFetchHandler,
  createClient,
  DendraClientError,
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
