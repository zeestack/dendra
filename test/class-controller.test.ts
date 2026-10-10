import { describe, it, expect } from "vitest";
import {
  initNexus,
  createCaller,
  s,
  type RouterRecord,
} from "../src/index.ts";

const { route } = initNexus<{ who: string }>();

// A "controller" is just a class whose fields are procedures. No decorators.
// The constructor can inject dependencies; handlers (arrow fields) close over
// `this`, so they can use them.
class MathController {
  base: number;
  constructor(base: number) {
    this.base = base;
  }

  add = route
    .input(s.object({ a: s.number(), b: s.number() }))
    .handler(({ input }) => this.base + input.a + input.b);

  double = route
    .input(s.object({ n: s.number() }))
    .handler(({ input }) => input.n * 2);
}

// An *instance* goes into the router — its type is { add, double }, which is a
// RouterRecord, so inference and dispatch work exactly like a plain object.
const router = {
  math: new MathController(100),
  ping: route.handler(() => "pong"),
} satisfies RouterRecord;

describe("class-based controllers (no decorators)", () => {
  it("dispatches instance-field procedures", async () => {
    const c = createCaller(router, { who: "x" });
    expect(await c.math.add({ a: 2, b: 3 })).toBe(105); // base(100) + 2 + 3
    expect(await c.math.double({ n: 4 })).toBe(8);
    expect(await c.ping()).toBe("pong");
  });
});
