import { describe, it, expect } from "vitest";
import {
  initDendra,
  createCaller,
  DendraError,
  s,
  type RouterRecord,
} from "../src/index.ts";

const { route } = initDendra<{ who: string }>();

const router = {
  add: route
    .input(s.object({ a: s.number(), b: s.number() }))
    .handler(({ input }) => input.a + input.b),
  greet: route.handler(({ ctx }) => `hi ${ctx.who}`),
  count: route
    .input(s.object({ to: s.number() }))
    .stream(async function* ({ input }) {
      for (let i = 1; i <= input.to; i++) yield i;
    }),
} satisfies RouterRecord;

describe("createCaller (in-process)", () => {
  it("runs a unary procedure with context", async () => {
    const c = createCaller(router, { who: "ada" });
    expect(await c.add({ a: 2, b: 3 })).toBe(5);
    expect(await c.greet()).toBe("hi ada");
  });

  it("validates input and throws DendraError", async () => {
    const c = createCaller(router, { who: "x" });
    await expect(
      c.add({ a: 1, b: "no" as unknown as number }),
    ).rejects.toBeInstanceOf(DendraError);
  });

  it("runs a streaming procedure", async () => {
    const c = createCaller(router, { who: "x" });
    const out: number[] = [];
    for await (const n of c.count({ to: 3 })) out.push(n);
    expect(out).toEqual([1, 2, 3]);
  });
});
