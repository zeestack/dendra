import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";

// Runs against the built package (CI builds before testing). Every CommonJS
// subpath must share one copy of core: a duplicate means `instanceof
// DendraError` fails for errors core throws, and `.after()` reports a guard's
// error as INTERNAL.
const require = createRequire(import.meta.url);
const built = existsSync(new URL("../dist/index.cjs", import.meta.url));
// Required inside each test: a skipped describe still runs its body.
const load = () => ({
  dendra: require("../dist/index.cjs"),
  adapter: require("../dist/adapter.cjs"),
});

describe.skipIf(!built)("CommonJS build", () => {
  it("dendra/adapter throws the same DendraError class as dendra", async () => {
    const { dendra, adapter } = load();
    const { route } = dendra.initDendra();
    const router = { x: route.input(dendra.s.object({ n: dendra.s.number() })).handler(() => 1) };
    const err = await adapter
      .invokeUnary(adapter.resolveProc(router, ["x"]), { n: "no" }, {})
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(dendra.DendraError);
    expect(err).toMatchObject({ code: "BAD_REQUEST" });
  });

  it("dendra/next maps a core NOT_FOUND to notFound()", async () => {
    const { dendra } = load();
    const next = require("../dist/next.cjs");
    const { route } = dendra.initDendra();
    const caller = dendra.createCaller({
      x: route.handler(() => {
        throw new dendra.DendraError("NOT_FOUND", "gone");
      }),
    });
    // notFound() throws Next's own error; it must not be rethrown as-is.
    const err = await next.orPage(caller.x()).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(dendra.DendraError);
    expect(String((err as { digest?: string }).digest ?? err)).toMatch(/NOT_FOUND|404/);
  });

  it("after-hooks see a guard's code under require()", async () => {
    const { dendra, adapter } = load();
    const { route } = dendra.initDendra();
    const seen: string[] = [];
    const router = {
      x: route
        .after(({ code }: { code?: string }) => {
          seen.push(code ?? "");
        })
        .use(() => {
          throw new dendra.DendraError("UNAUTHORIZED", "sign in");
        })
        .handler(() => 1),
    };
    await adapter.invokeUnary(adapter.resolveProc(router, ["x"]), undefined, {}).catch(() => {});
    expect(seen).toEqual(["UNAUTHORIZED"]);
  });
});
