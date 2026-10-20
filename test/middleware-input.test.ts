import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  initDendra,
  createCaller,
  DendraError,
  s,
  toToolset,
  type RouterRecord,
} from "../src/index.ts";

interface Ctx {
  memberOf: number[];
}
const { route } = initDendra<Ctx>();

// A tenant guard: declares the input it needs, then checks it — typed and
// already validated (coerced to a number by the schema, not by the guard).
const inWorkspace = route
  .input(z.object({ workspaceId: z.coerce.number() }))
  .use(({ ctx, input }) => {
    if (!ctx.memberOf.includes(input.workspaceId)) {
      throw new DendraError("FORBIDDEN", "Not a member");
    }
    return { workspaceId: input.workspaceId };
  });

const router = {
  // Later .input() extends the guard's input instead of replacing it.
  rename: inWorkspace
    .input(z.object({ title: z.string() }))
    .handler(({ input, ctx }) => ({ ws: ctx.workspaceId, ...input })),
  // Schemas from different libraries mix.
  mixed: inWorkspace
    .input(s.object({ n: s.number() }))
    .handler(({ input }) => input),
} satisfies RouterRecord;

describe("input declared before middleware", () => {
  it("gives middleware the validated input", async () => {
    const c = createCaller(router, { memberOf: [7] });
    expect(await c.rename({ workspaceId: "7" as never, title: "x" })).toEqual({
      ws: 7,
      workspaceId: 7,
      title: "x",
    });
  });

  it("lets the guard reject on that input", async () => {
    const c = createCaller(router, { memberOf: [7] });
    await expect(c.rename({ workspaceId: 8, title: "x" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("validates every schema in the chain and reports all issues at once", async () => {
    const c = createCaller(router, { memberOf: [7] });
    const err = await c
      .rename({ workspaceId: "nope", title: 1 } as never)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DendraError);
    expect((err as DendraError).code).toBe("BAD_REQUEST");
    const paths = ((err as DendraError).details as { path: unknown[] }[]).map(
      (i) => i.path[0],
    );
    expect(paths).toEqual(expect.arrayContaining(["workspaceId", "title"]));
  });

  it("mixes Standard Schema libraries in one chain", async () => {
    const c = createCaller(router, { memberOf: [7] });
    expect(await c.mixed({ workspaceId: 7, n: 2 })).toEqual({ workspaceId: 7, n: 2 });
  });

  it("keeps the earlier schema's value when a later one passes keys through", async () => {
    const p = inWorkspace
      .input(z.object({ title: z.string() }).passthrough())
      .handler(({ input }) => input);
    const c = createCaller({ p }, { memberOf: [7] });
    // The guard checked the coerced number; the handler must see the same value.
    expect(await c.p({ workspaceId: "7" as never, title: "x" })).toEqual({
      workspaceId: 7,
      title: "x",
    });
  });

  it("rejects a chained schema whose output isn't an object", async () => {
    const p = route
      .input(z.object({ a: z.number() }))
      // @ts-expect-error — chained input must be an object
      .input(z.object({ a: z.number() }).transform((v) => v.a))
      .handler(() => "x");
    const c = createCaller({ p }, { memberOf: [] });
    await expect(c.p({ a: 1 } as never)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });
});

describe("chained built-in object schemas", () => {
  const base = route.input(s.object({ workspaceId: s.integer() }).strict());

  it("merge into one object, so strict checks the combined keys", async () => {
    const p = base.input(s.object({ title: s.string() })).handler(({ input }) => input);
    const c = createCaller({ p }, { memberOf: [] });
    expect(await c.p({ workspaceId: 1, title: "t" })).toEqual({ workspaceId: 1, title: "t" });
    await expect(
      c.p({ workspaceId: 1, title: "t", extra: true } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("publish one combined JSON schema to tools and OpenAPI", () => {
    const p = base
      .input(s.object({ title: s.string(), note: s.optional(s.string()) }))
      .ai({ description: "Rename" })
      .handler(() => "ok");
    expect(p.inputJsonSchema).toEqual({
      type: "object",
      properties: {
        workspaceId: { type: "integer" },
        title: { type: "string" },
        note: { type: "string" },
      },
      required: ["workspaceId", "title"],
      additionalProperties: false,
    });
    const [tool] = toToolset({ p }, { format: "plain" }) as { inputSchema: unknown }[];
    expect(tool.inputSchema).toEqual(p.inputJsonSchema);
  });
});

describe("chained schemas without a JSON schema", () => {
  it("publish only the parts that have one", () => {
    const p = route
      .input(z.object({ workspaceId: z.number() }))
      .input(s.object({ title: s.string() }))
      .handler(() => "ok");
    expect(p.inputJsonSchema).toEqual({
      type: "object",
      properties: { title: { type: "string" } },
      required: ["title"],
    });
  });
});
