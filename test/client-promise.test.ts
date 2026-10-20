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
  ticks: route.stream(async function* () {
    yield 1;
    yield 2;
  }),
} satisfies RouterRecord;
type App = typeof appRouter;

function setup() {
  const handler = toFetchHandler(appRouter);
  const seen: string[] = [];
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    seen.push(String(input));
    return handler(new Request(String(input), init));
  }) as typeof fetch;
  return { api: createClient<App>("http://local", { fetch: fetchImpl }), seen };
}

describe("client calls are real Promises (#4)", () => {
  it("is an instance of Promise", () => {
    const { api } = setup();
    const call = api.add({ a: 1, b: 2 });
    expect(call).toBeInstanceOf(Promise);
    return call;
  });

  it("supports .catch and .finally", async () => {
    const { api } = setup();
    let finished = false;
    const err = await api
      .add({ a: 1, b: "x" as unknown as number })
      .finally(() => {
        finished = true;
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DendraClientError);
    expect(finished).toBe(true);
  });

  it("works with Promise.race and Promise.resolve", async () => {
    const { api } = setup();
    expect(await Promise.race([api.add({ a: 2, b: 2 })])).toBe(4);
    expect(await Promise.resolve(api.add({ a: 3, b: 3 }))).toBe(6);
  });

  it("stays lazy: nothing is sent until awaited or iterated", async () => {
    const { api, seen } = setup();
    api.add({ a: 1, b: 1 });
    const ticks = api.ticks();
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toEqual([]);

    const out: number[] = [];
    for await (const t of ticks) out.push(t);
    expect(out).toEqual([1, 2]);
    expect(seen).toHaveLength(1);
  });
});
