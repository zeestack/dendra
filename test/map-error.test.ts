import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  initDendra,
  createCaller,
  createToolExecutor,
  createMcpBridge,
  toFetchHandler,
  createApprovals,
  createWsSession,
  createWsClient,
  createClient,
  DendraError,
  type AfterInfo,
  type RouterRecord,
} from "../src/index.ts";

// `.mapError()` turns an app's own errors into DendraErrors in one place,
// before masking, on every transport (#77).

class WpError extends Error {}
class BudgetError extends Error {}

const seen: AfterInfo<unknown, unknown>[] = [];
const { route } = initDendra();
const app = route
  .after((i) => void seen.push(i as AfterInfo<unknown, unknown>))
  .mapError((e) => (e instanceof WpError ? new DendraError("BAD_REQUEST", e.message) : undefined));

const router = {
  publish: app.ai().handler(() => {
    throw new WpError("The site refused the post: check the WordPress connection.");
  }),
  // Mappers chain: a later one handles what the earlier one passes on.
  spend: app
    .mapError((e) => (e instanceof BudgetError ? new DendraError("TOO_MANY_REQUESTS", "Monthly limit reached.") : undefined))
    .ai()
    .handler(() => {
      throw new BudgetError("internal budget detail");
    }),
  crash: app.handler(() => {
    throw new TypeError("secret internals");
  }),
  guarded: app
    .use((): void => {
      throw new WpError("from a guard");
    })
    .handler(() => 1),
  denied: app.handler(() => {
    throw new DendraError("FORBIDDEN", "Not yours");
  }),
  feed: app.stream(async function* () {
    yield 1;
    throw new WpError("stream broke");
  }),
} satisfies RouterRecord;

let logged: unknown[][];
beforeEach(() => {
  seen.length = 0;
  logged = [];
  vi.spyOn(console, "error").mockImplementation((...a) => void logged.push(a));
});
afterEach(() => vi.restoreAllMocks());

const handler = toFetchHandler(router);
const fetchVia: typeof fetch = (input, init) => handler(new Request(input, init));
const api = createClient<typeof router>("http://x", { fetch: fetchVia });

describe(".mapError()", () => {
  it("maps over HTTP, so the client reads the app's message", async () => {
    await expect(api.publish()).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "The site refused the post: check the WordPress connection.",
    });
  });

  it("maps for the in-process caller", async () => {
    await expect(createCaller(router, {}).publish()).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("maps for tool calls and the MCP bridge", async () => {
    await expect(createToolExecutor(router, {})("publish", {})).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const res = await createMcpBridge(router, {}).callTool("publish", {});
    expect(res).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("WordPress") }] });
  });

  it("chains mappers, in order", async () => {
    await expect(api.spend()).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS", message: "Monthly limit reached." });
  });

  it("leaves unmapped errors alone, so they're still masked and logged", async () => {
    await expect(api.crash()).rejects.toMatchObject({ code: "INTERNAL", message: "Internal error" });
    expect(logged.some((a) => a.some((x) => x instanceof TypeError))).toBe(true);
  });

  it("maps errors thrown by guards too", async () => {
    await expect(api.guarded()).rejects.toMatchObject({ code: "BAD_REQUEST", message: "from a guard" });
  });

  it("never touches a DendraError", async () => {
    await expect(api.denied()).rejects.toMatchObject({ code: "FORBIDDEN", message: "Not yours" });
  });

  it("maps a stream's error frame", async () => {
    const got: unknown[] = [];
    await expect(
      (async () => {
        for await (const v of api.feed()) got.push(v);
      })(),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "stream broke" });
    expect(got).toEqual([1]);
  });

  it("after-hooks see the mapped error and its code", async () => {
    await createCaller(router, {}).publish().catch(() => {});
    expect(seen.at(-1)).toMatchObject({ ok: false, code: "BAD_REQUEST" });
    expect((seen.at(-1) as { error: unknown }).error).toBeInstanceOf(DendraError);
  });

  it("keeps the original as the mapped error's cause", async () => {
    const err = await createCaller(router, {}).publish().catch((e: unknown) => e);
    expect((err as Error).cause).toBeInstanceOf(WpError);
  });

  it("logs a mapper that throws and carries on with the original error", async () => {
    const r = {
      p: route
        .mapError(() => {
          throw new Error("mapper bug");
        })
        .handler(() => {
          throw new WpError("x");
        }),
    } satisfies RouterRecord;
    const err = await createCaller(r, {}).p().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WpError);
    expect(logged.some((a) => String(a[0]).includes("mapError"))).toBe(true);
  });

  it("maps over WebSockets", async () => {
    const client = createWsClient<typeof router>((d) => queueMicrotask(() => session.handleMessage(d)));
    const session = createWsSession(router, (d) => queueMicrotask(() => client.receive(d)));
    await expect(client.api.publish()).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("WordPress") });
  });

  it("maps when a person approves a confirm tool", async () => {
    const r = { p: app.ai({ confirm: true }).handler(() => { throw new WpError("refused on approval"); }) } satisfies RouterRecord;
    const approvals = createApprovals(r);
    const { actionId } = (await createToolExecutor(r, {}, { approvals })("p", {})) as { actionId: string };
    await expect(approvals.approve(actionId, {})).rejects.toMatchObject({ code: "BAD_REQUEST", message: "refused on approval" });
  });
});
