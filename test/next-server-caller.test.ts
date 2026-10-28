import { describe, it, expect, vi, beforeEach } from "vitest";
import { initDendra, s, DendraError } from "../src/index.ts";

// headers() only works inside a Next request; stand in for it.
let incoming = new Headers();
vi.mock("next/headers", () => ({ headers: async () => incoming }));

const { createServerCaller } = await import("../src/next.ts");

interface Ctx {
  user: string | null;
}

const { route } = initDendra<Ctx>();
const router = {
  whoami: route.handler(({ ctx }) => ctx.user),
  add: route
    .input(s.object({ a: s.number(), b: s.number() }))
    .handler(({ input }) => input.a + input.b),
  at: route.handler(() => new Date(0)),
  secret: route
    .use(({ ctx }) => {
      if (!ctx.user) throw new DendraError("UNAUTHORIZED", "Sign in");
      return { user: ctx.user };
    })
    .handler(({ ctx }) => `hi ${ctx.user}`),
};

const fromCookie = (req: Request): Ctx => ({
  user: /(?:^|; )session=([^;]+)/.exec(req.headers.get("cookie") ?? "")?.[1] ?? null,
});

beforeEach(() => {
  incoming = new Headers();
});

describe("createServerCaller (#24)", () => {
  it("builds ctx from the incoming request headers", async () => {
    incoming = new Headers({ cookie: "theme=dark; session=ada", host: "example.com" });
    const serverCaller = createServerCaller(router, fromCookie);
    const api = await serverCaller();
    expect(await api.whoami()).toBe("ada");
    expect(await api.secret()).toBe("hi ada");
  });

  it("gives createContext a Request whose URL is the request's origin", async () => {
    incoming = new Headers({ host: "app.local:3000", "x-forwarded-proto": "https" });
    const createContext = vi.fn((_req: Request): Ctx => ({ user: null }));
    await createServerCaller(router, createContext)();
    const req = createContext.mock.calls[0]![0];
    expect(req).toBeInstanceOf(Request);
    expect(new URL(req.url).origin).toBe("https://app.local:3000");
  });

  it("prefers x-forwarded-host, and falls back to localhost", async () => {
    const createContext = vi.fn((_req: Request): Ctx => ({ user: null }));
    incoming = new Headers({ host: "internal:8080", "x-forwarded-host": "public.example" });
    await createServerCaller(router, createContext)();
    incoming = new Headers();
    await createServerCaller(router, createContext)();
    expect(createContext.mock.calls.map(([r]) => new URL(r.url).origin)).toEqual([
      "http://public.example",
      "http://localhost",
    ]);
  });

  it("accepts an async createContext", async () => {
    incoming = new Headers({ cookie: "session=grace" });
    const api = await createServerCaller(router, async (req) => fromCookie(req))();
    expect(await api.whoami()).toBe("grace");
  });

  it("is a Caller: validated input, real result types, dendra errors", async () => {
    const api = await createServerCaller(router, fromCookie)();
    expect(await api.add({ a: 2, b: 3 })).toBe(5);
    const at: Date = await api.at();
    expect(at).toBeInstanceOf(Date);
    await expect(api.add({ a: "2" } as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(api.secret()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});
