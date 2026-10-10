import { expectTypeOf } from "vitest";
import { initNexus, createCaller, s, type RouterRecord } from "../src/index.ts";

// Type-level tests: prove end-to-end inference with no codegen.
const { route } = initNexus<{ db: string }>();

const router = {
  add: route
    .input(s.object({ a: s.number(), b: s.number() }))
    .handler(({ input }) => input.a + input.b),
  stream: route
    .input(s.object({ n: s.number() }))
    .stream(async function* () {
      yield "x";
    }),
  nested: {
    get: route
      .input(s.object({ id: s.string() }))
      .handler(() => ({ id: "1" })),
  },
} satisfies RouterRecord;

const c = createCaller(router, { db: "x" });

// Unary: input + output inferred from the schema and handler.
expectTypeOf(c.add).toEqualTypeOf<(input: { a: number; b: number }) => Promise<number>>();

// Streaming: returns an AsyncIterable of the yielded element type.
expectTypeOf(c.stream).returns.toEqualTypeOf<AsyncIterable<string>>();

// Nested routers recurse.
expectTypeOf(c.nested.get).parameter(0).toEqualTypeOf<{ id: string }>();
expectTypeOf(c.nested.get).returns.toEqualTypeOf<Promise<{ id: string }>>();
