import { expectTypeOf } from "vitest";
import { initDendra, createCaller, s, type RouterRecord } from "../src/index.ts";

// Type-level tests: prove end-to-end inference with no codegen.
const { route } = initDendra<{ db: string }>();

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

// --- middleware enriches ctx, and the enrichment is typed downstream ---------
const authed = route.use(() => ({ userId: "u1" }));
const mwRouter = {
  me: authed.handler(({ ctx }) => {
    expectTypeOf(ctx.userId).toEqualTypeOf<string>(); // added by .use()
    expectTypeOf(ctx.db).toEqualTypeOf<string>(); // base ctx still present
    return ctx.userId;
  }),
  // stacked middleware: second sees the first's additions, handler sees both
  stacked: authed
    .use(({ ctx }) => {
      expectTypeOf(ctx.userId).toEqualTypeOf<string>();
      return { role: "admin" as const };
    })
    .handler(({ ctx }) => `${ctx.userId}:${ctx.role}`),
};
const mc = createCaller(mwRouter, { db: "x" });
expectTypeOf(mc.me).returns.toEqualTypeOf<Promise<string>>();
expectTypeOf(mc.stacked).returns.toEqualTypeOf<Promise<string>>();

// --- typed .output() constrains the return and flows to the client -----------
const UserSchema = s.object({ id: s.string(), name: s.string() });
const outRouter = {
  getUser: route
    .input(s.object({ id: s.string() }))
    .output(UserSchema)
    .handler(({ input }) => ({ id: input.id, name: "Ada" })),
};
const oc = createCaller(outRouter, { db: "x" });
expectTypeOf(oc.getUser).returns.toEqualTypeOf<Promise<{ id: string; name: string }>>();

// @ts-expect-error — .output(UserSchema) requires the handler to return that shape
route.output(UserSchema).handler(() => ({ id: "1" }));

// --- deeply nested routers keep inferring -----------------------------------
const deep = {
  a: { b: { c: route.input(s.object({ x: s.number() })).handler(({ input }) => input.x) } },
};
const dc = createCaller(deep, { db: "x" });
expectTypeOf(dc.a.b.c).toEqualTypeOf<(input: { x: number }) => Promise<number>>();

// --- new combinators infer precise input types ------------------------------
const combRouter = {
  create: route
    .input(
      s.object({
        status: s.enum(["open", "closed"] as const), // -> union literal
        kind: s.literal("note"), // -> narrow literal
        id: s.union([s.string(), s.number()]), // -> string | number
        title: s.string().min(1).max(200), // constraints keep `string`
        count: s.integer().min(0), // integer stays `number`
        owner: s.nullable(s.string()), // string | null
        meta: s.record(s.string()), // Record<string, string>
      }),
    )
    .handler(({ input }) => input),
};
const cc = createCaller(combRouter, { db: "x" });
expectTypeOf(cc.create).parameter(0).toEqualTypeOf<{
  status: "open" | "closed";
  kind: "note";
  id: string | number;
  title: string;
  count: number;
  owner: string | null;
  meta: Record<string, string>;
}>();

// After-hooks see ctx as enriched by the middlewares before them, plus the input.
route
  .use(() => ({ userId: "u1" }))
  .input(s.object({ id: s.string() }))
  .after((info) => {
    expectTypeOf(info.ctx.userId).toEqualTypeOf<string>();
    expectTypeOf(info.ctx.db).toEqualTypeOf<string>();
    expectTypeOf(info.input).toEqualTypeOf<{ id: string }>();
    if (!info.ok) expectTypeOf(info.code).toEqualTypeOf<import("../src/index.ts").ErrorCode>();
  })
  .handler(() => "ok");

// `.get()` marks a read; the client keeps the brand so `urlFor` can require it.
{
  const r = {
    read: route.get().handler(() => 1),
    write: route.handler(() => 1),
  };
  const api = createCaller(r, { db: "x" });
  expectTypeOf(api.read).toMatchTypeOf<import("../src/index.ts").ReadBrand>();
  expectTypeOf(api.write).not.toMatchTypeOf<import("../src/index.ts").ReadBrand>();
}

// s.file() infers File.
expectTypeOf<import("../src/schema.ts").InferOutput<ReturnType<typeof s.file>>>().toEqualTypeOf<File>();
