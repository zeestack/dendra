import { describe, it, expect, vi } from "vitest";
import {
  initDendra,
  createCaller,
  createToolExecutor,
  toFetchHandler,
  toRestHandler,
  createWsSession,
  DendraError,
  s,
  type AfterInfo,
  type RouterRecord,
} from "../src/index.ts";

interface BaseCtx {
  token: string | null;
}
const { route } = initDendra<BaseCtx>();

// Collects every after-hook call so tests can assert on what the hook saw.
function recorder() {
  const seen: AfterInfo<unknown, unknown>[] = [];
  const hook = (info: AfterInfo<unknown, unknown>) => {
    seen.push(info);
  };
  return { seen, hook };
}

describe("after-hooks (.after)", () => {
  it("sees the result, input, path, enriched ctx and duration on success", async () => {
    const { seen, hook } = recorder();
    const router = {
      notes: {
        create: route
          .use(() => ({ userId: "u1" }))
          .input(s.object({ title: s.string() }))
          .after(hook)
          .handler(({ input }) => ({ id: 7, title: input.title })),
      },
    } satisfies RouterRecord;

    const c = createCaller(router, { token: "t" });
    expect(await c.notes.create({ title: "hi" })).toEqual({ id: 7, title: "hi" });

    expect(seen).toHaveLength(1);
    const info = seen[0];
    expect(info.ok).toBe(true);
    expect(info.result).toEqual({ id: 7, title: "hi" });
    expect(info.input).toEqual({ title: "hi" });
    expect(info.path).toBe("notes.create");
    expect(info.transport).toBe("caller");
    expect((info.ctx as { userId: string }).userId).toBe("u1");
    expect(info.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("sees the error and its code when the handler throws, and the error still reaches the caller", async () => {
    const { seen, hook } = recorder();
    const router = {
      approve: route.after(hook).handler(() => {
        throw new DendraError("CONFLICT", "Draft isn't finished yet");
      }),
      boom: route.after(hook).handler(() => {
        throw new Error("kaboom");
      }),
    } satisfies RouterRecord;

    const c = createCaller(router, { token: "t" });
    await expect(c.approve()).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(c.boom()).rejects.toThrow("kaboom");

    expect(seen.map((i) => [i.ok, i.code])).toEqual([
      [false, "CONFLICT"],
      [false, "INTERNAL"],
    ]);
    expect(seen[0].error).toBeInstanceOf(DendraError);
  });

  it("logs a throwing hook instead of failing the call", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const router = {
      ping: route
        .after(() => {
          throw new Error("audit db down");
        })
        .handler(() => "pong"),
    } satisfies RouterRecord;

    expect(await createCaller(router, { token: "t" }).ping()).toBe("pong");
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it("awaits async hooks before the call settles", async () => {
    const order: string[] = [];
    const router = {
      ping: route
        .after(async () => {
          await new Promise((r) => setTimeout(r, 5));
          order.push("hook");
        })
        .handler(() => "pong"),
    } satisfies RouterRecord;

    await createCaller(router, { token: "t" }).ping();
    order.push("returned");
    expect(order).toEqual(["hook", "returned"]);
  });

  it("only runs hooks registered before a middleware that rejects", async () => {
    const outer = recorder();
    const inner = recorder();
    const router = {
      me: route
        .after(outer.hook)
        .use(({ ctx }) => {
          if (!ctx.token) throw new DendraError("UNAUTHORIZED", "Sign in required");
          return { userId: "u_" + ctx.token };
        })
        .after(inner.hook)
        .handler(({ ctx }) => ctx.userId),
    } satisfies RouterRecord;

    await expect(createCaller(router, { token: null }).me()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(outer.seen.map((i) => i.code)).toEqual(["UNAUTHORIZED"]);
    expect(inner.seen).toHaveLength(0);

    await createCaller(router, { token: "bob" }).me();
    expect(outer.seen).toHaveLength(2);
    expect(inner.seen).toHaveLength(1);
    expect((inner.seen[0].ctx as { userId: string }).userId).toBe("u_bob");
  });

  it("runs multiple hooks in registration order", async () => {
    const order: number[] = [];
    const router = {
      ping: route
        .after(() => void order.push(1))
        .after(() => void order.push(2))
        .handler(() => "pong"),
    } satisfies RouterRecord;

    await createCaller(router, { token: "t" }).ping();
    expect(order).toEqual([1, 2]);
  });

  it("does not run hooks when input validation fails", async () => {
    const { seen, hook } = recorder();
    const router = {
      add: route
        .input(s.object({ a: s.number() }))
        .after(hook)
        .handler(({ input }) => input.a),
    } satisfies RouterRecord;

    await expect(
      createCaller(router, { token: "t" }).add({ a: "x" } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(seen).toHaveLength(0);
  });

  it("runs once a stream finishes, with ok/error", async () => {
    const { seen, hook } = recorder();
    const router = {
      ticks: route.after(hook).stream(async function* () {
        yield 1;
        yield 2;
      }),
      broken: route.after(hook).stream(async function* () {
        yield 1;
        throw new DendraError("INTERNAL", "lost");
      }),
    } satisfies RouterRecord;

    const c = createCaller(router, { token: "t" });
    const got: number[] = [];
    for await (const n of c.ticks()) got.push(n);
    expect(got).toEqual([1, 2]);
    await expect(async () => {
      for await (const _ of c.broken()) void _;
    }).rejects.toThrow("lost");

    expect(seen.map((i) => [i.path, i.ok])).toEqual([
      ["ticks", true],
      ["broken", false],
    ]);
  });

  describe("on every transport", () => {
    const make = () => {
      const { seen, hook } = recorder();
      const router = {
        notes: {
          get: route
            .get("/notes/:id")
            .input(s.object({ id: s.number() }))
            .ai()
            .after(hook)
            .handler(({ input }) => ({ id: input.id })),
        },
      } satisfies RouterRecord;
      return { seen, router };
    };

    it("RPC (toFetchHandler), including batch", async () => {
      const { seen, router } = make();
      const handler = toFetchHandler(router);
      await handler(
        new Request("http://x/rpc/notes.get", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: 1 }),
        }),
      );
      await handler(
        new Request("http://x/rpc/__batch", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify([{ path: "notes.get", input: { id: 2 } }]),
        }),
      );
      expect(seen.map((i) => [i.transport, i.path, i.result])).toEqual([
        ["rpc", "notes.get", { id: 1 }],
        ["rpc", "notes.get", { id: 2 }],
      ]);
    });

    it("REST (toRestHandler)", async () => {
      const { seen, router } = make();
      await toRestHandler(router)(new Request("http://x/notes/3"));
      expect(seen.map((i) => [i.transport, i.path, i.result])).toEqual([
        ["rest", "notes.get", { id: 3 }],
      ]);
    });

    it("AI tool executor", async () => {
      const { seen, router } = make();
      await createToolExecutor(router, { token: "t" })("notes.get", { id: 4 });
      expect(seen.map((i) => [i.transport, i.path])).toEqual([["tool", "notes.get"]]);
    });

    it("WebSocket", async () => {
      const { seen, router } = make();
      const sent: string[] = [];
      const session = createWsSession(router, (m) => void sent.push(m), { token: "t" });
      session.handleMessage(
        JSON.stringify({ id: 1, type: "call", path: "notes.get", input: { id: 5 } }),
      );
      await vi.waitFor(() => expect(sent).toHaveLength(1));
      expect(seen.map((i) => [i.transport, i.path])).toEqual([["ws", "notes.get"]]);
    });
  });
});
