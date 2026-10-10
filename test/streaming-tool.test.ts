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
  // A streaming procedure, exposed as a tool.
  story: route
    .input(s.object({ topic: s.string() }))
    .ai({ description: "Tell a short story about a topic" })
    .stream(async function* ({ input }) {
      for (const word of ["once", "upon", input.topic]) yield word + " ";
    }),
  // A streaming procedure that yields non-strings → collected as an array.
  nums: route
    .input(s.object({ n: s.number() }))
    .ai({ description: "Emit numbers" })
    .stream(async function* ({ input }) {
      for (let i = 0; i < input.n; i++) yield i;
    }),
} satisfies RouterRecord;

describe("streaming tools (collected results)", () => {
  it("exposes streaming procedures as tools", () => {
    const tools = toToolset(router, { format: "plain" }) as Array<{ name: string }>;
    expect(tools.map((t) => t.name).sort()).toEqual(["nums", "story"]);
  });

  it("joins streamed string chunks into one result", async () => {
    const execute = createToolExecutor(router, {});
    expect(await execute("story", { topic: "dragons" })).toBe(
      "once upon dragons ",
    );
  });

  it("collects non-string chunks into an array", async () => {
    const execute = createToolExecutor(router, {});
    expect(await execute("nums", { n: 3 })).toEqual([0, 1, 2]);
  });
});
