import { describe, it, expect } from "vitest";
import { DendraClientError, DendraError } from "../src/index.ts";
import { orPage } from "../src/next.ts";

// notFound() and redirect() throw errors Next recognises by their digest.
const digest = async (p: Promise<unknown>) =>
  ((await p.then(() => undefined, (e: unknown) => e)) as { digest?: string } | undefined)?.digest;

describe("orPage (#8)", () => {
  it("passes a result through", async () => {
    expect(await orPage(Promise.resolve(42))).toBe(42);
  });

  it("NOT_FOUND → notFound()", async () => {
    const call = Promise.reject(new DendraError("NOT_FOUND", "No such note"));
    expect(await digest(orPage(call))).toBe("NEXT_HTTP_ERROR_FALLBACK;404");
  });

  it("BAD_REQUEST → notFound() (a bad id in the URL is a missing page)", async () => {
    const call = Promise.reject(new DendraClientError({ code: "BAD_REQUEST" }));
    expect(await digest(orPage(call))).toBe("NEXT_HTTP_ERROR_FALLBACK;404");
  });

  it("UNAUTHORIZED → redirect(signIn)", async () => {
    const call = Promise.reject(new DendraError("UNAUTHORIZED", "Sign in"));
    expect(await digest(orPage(call, { signIn: "/sign-in" }))).toMatch(
      /^NEXT_REDIRECT;\w+;\/sign-in;307;/,
    );
  });

  it("UNAUTHORIZED without signIn is rethrown", async () => {
    const err = new DendraError("UNAUTHORIZED", "Sign in");
    await expect(orPage(Promise.reject(err))).rejects.toBe(err);
  });

  it("other errors are rethrown untouched", async () => {
    const forbidden = new DendraError("FORBIDDEN", "No");
    await expect(orPage(Promise.reject(forbidden), { signIn: "/s" })).rejects.toBe(forbidden);
    const boom = new Error("boom");
    await expect(orPage(Promise.reject(boom))).rejects.toBe(boom);
  });
});

describe("orPage only maps dendra errors", () => {
  it("rethrows a non-dendra error that happens to carry a matching code", async () => {
    const other = Object.assign(new Error("db"), { code: "NOT_FOUND" });
    await expect(orPage(Promise.reject(other))).rejects.toBe(other);
  });
});
