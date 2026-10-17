import { describe, it, expect, expectTypeOf } from "vitest";
import { z } from "zod";
import { z as z3 } from "zod/v3";
import * as v from "valibot";
import { type } from "arktype";
import { initDendra, createCaller, DendraError, type RouterRecord } from "../src/index.ts";

// The README promises Zod, Valibot and ArkType work as `.input()`. These pin it
// at the type level (the file must compile) and at runtime.
const { route } = initDendra();

const router = {
  zod4: route.input(z.object({ a: z.number() })).handler(({ input }) => {
    expectTypeOf(input.a).toEqualTypeOf<number>();
    return input.a;
  }),
  zod3: route.input(z3.object({ a: z3.number() })).handler(({ input }) => {
    expectTypeOf(input.a).toEqualTypeOf<number>();
    return input.a;
  }),
  valibot: route.input(v.object({ a: v.number() })).handler(({ input }) => {
    expectTypeOf(input.a).toEqualTypeOf<number>();
    return input.a;
  }),
  arktype: route.input(type({ a: "number" })).handler(({ input }) => {
    expectTypeOf(input.a).toEqualTypeOf<number>();
    return input.a;
  }),
} satisfies RouterRecord;

describe("third-party Standard Schema libraries", () => {
  const c = createCaller(router);

  for (const name of ["zod4", "zod3", "valibot", "arktype"] as const) {
    it(`${name}: validates and infers input`, async () => {
      expect(await c[name]({ a: 2 })).toBe(2);
      const err = await c[name]({ a: "x" } as never).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(DendraError);
      expect((err as DendraError).code).toBe("BAD_REQUEST");
    });
  }

  it("normalises object path segments in error details to plain keys", async () => {
    // The spec allows `{ key }` segments; a schema that uses them must still
    // produce readable `details` (["items", 0, "title"]).
    const segmented = {
      "~standard": {
        version: 1 as const,
        vendor: "test",
        validate: () => ({
          issues: [{ message: "bad", path: [{ key: "items" }, 0, { key: "title" }] }],
        }),
      },
    };
    const r = { p: route.input(segmented).handler(() => 1) };
    const err = (await createCaller(r).p(undefined as never).catch((e: unknown) => e)) as DendraError;
    expect((err.details as Array<{ path: unknown[] }>)[0].path).toEqual(["items", 0, "title"]);
  });
});
