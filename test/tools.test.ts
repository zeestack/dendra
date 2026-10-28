import { describe, it, expect } from "vitest";
import {
  initDendra,
  toToolset,
  createToolExecutor,
  s,
  type RouterRecord,
} from "../src/index.ts";

const { route } = initDendra();

const router = {
  math: {
    add: route
      .input(s.object({ a: s.number(), b: s.number() }))
      .ai({ description: "add two numbers" })
      .handler(({ input }) => input.a + input.b),
  },
  secret: route
    .input(s.object({ x: s.string() }))
    .handler(({ input }) => input.x),
} satisfies RouterRecord;

describe("AI tools", () => {
  it("exposes only .ai()-marked procedures", () => {
    const tools = toToolset(router, { format: "anthropic" }) as Array<{
      name: string;
    }>;
    expect(tools.map((t) => t.name)).toEqual(["math.add"]);
  });

  it("executes exposed tools and validates args", async () => {
    const execute = createToolExecutor(router, {});
    expect(await execute("math.add", { a: 2, b: 5 })).toBe(7);
    await expect(
      execute("math.add", { a: 2, b: "x" }),
    ).rejects.toThrow();
  });

  it("refuses to execute non-exposed procedures", async () => {
    const execute = createToolExecutor(router, {});
    await expect(execute("secret", { x: "hi" })).rejects.toThrow(
      /not found/,
    );
  });
});
