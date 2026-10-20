import { expectTypeOf } from "vitest";
import { z } from "zod";
import { initDendra, createCaller, s, type CallOptions } from "../src/index.ts";

// Input declared before .use() types the middleware's input, and later
// .input() calls extend it.
const { route } = initDendra<{ memberOf: number[] }>();

const inWorkspace = route
  .input(z.object({ workspaceId: z.coerce.number() }))
  .use(({ input }) => {
    expectTypeOf(input).toEqualTypeOf<{ workspaceId: number }>();
    return { ws: input.workspaceId };
  });

const rename = inWorkspace
  .input(s.object({ title: s.string() }))
  .after(({ input }) => {
    expectTypeOf(input).toEqualTypeOf<{ workspaceId: number; title: string }>();
  })
  .handler(({ input, ctx }) => {
    expectTypeOf(input).toEqualTypeOf<{ workspaceId: number; title: string }>();
    expectTypeOf(ctx.ws).toEqualTypeOf<number>();
    return input.title;
  });

const c = createCaller({ rename }, { memberOf: [] });
expectTypeOf(c.rename).toEqualTypeOf<
  (input: { workspaceId: number; title: string }, opts?: CallOptions) => Promise<string>
>();

// The earlier schema's type wins for a key both declare.
route
  .input(z.object({ id: z.number() }))
  .input(z.object({ id: z.string(), x: z.boolean() }))
  .handler(({ input }) => {
    expectTypeOf(input).toEqualTypeOf<{ id: number; x: boolean }>();
  });

// A chain needs object input on both sides.
route
  .input(z.string())
  // @ts-expect-error — can't extend non-object input
  .input(z.object({ a: z.number() }));
