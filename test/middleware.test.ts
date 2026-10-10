import { describe, it, expect } from "vitest";
import {
  initNexus,
  createCaller,
  NexusError,
  s,
  type RouterRecord,
} from "../src/index.ts";

interface BaseCtx {
  token: string | null;
}
const { route } = initNexus<BaseCtx>();

// Auth middleware: rejects when there's no token, and ENRICHES ctx with userId —
// which the handler then sees as typed.
const authed = route.use(({ ctx }) => {
  if (!ctx.token) throw new NexusError("UNAUTHORIZED", "Sign in required");
  return { userId: "u_" + ctx.token };
});

const router = {
  me: authed.handler(({ ctx }) => ctx.userId), // ctx.userId is typed here
  // second middleware stacks on top of the first
  adminOnly: authed
    .use(({ ctx }) => {
      if (ctx.userId !== "u_admin") throw new NexusError("FORBIDDEN", "No");
      return { role: "admin" as const };
    })
    .handler(({ ctx }) => `${ctx.userId}:${ctx.role}`),
} satisfies RouterRecord;

describe("middleware (.use)", () => {
  it("rejects when the guard throws", async () => {
    const c = createCaller(router, { token: null });
    await expect(c.me()).rejects.toBeInstanceOf(NexusError);
  });

  it("enriches ctx and passes it to the handler", async () => {
    const c = createCaller(router, { token: "alice" });
    expect(await c.me()).toBe("u_alice");
  });

  it("stacks multiple middlewares in order", async () => {
    const admin = createCaller(router, { token: "admin" });
    expect(await admin.adminOnly()).toBe("u_admin:admin");

    const nonAdmin = createCaller(router, { token: "bob" });
    await expect(nonAdmin.adminOnly()).rejects.toBeInstanceOf(NexusError);
  });
});
