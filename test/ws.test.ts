import { describe, it, expect } from "vitest";
import {
  initDendra,
  createWsSession,
  createWsClient,
  s,
  type RouterRecord,
} from "../src/index.ts";

const { route } = initDendra();

const router = {
  add: route
    .input(s.object({ a: s.number(), b: s.number() }))
    .handler(({ input }) => input.a + input.b),
  ticks: route.input(s.object({ n: s.number() })).stream(async function* ({
    input,
  }) {
    for (let i = 0; i < input.n; i++) yield i;
  }),
} satisfies RouterRecord;
type R = typeof router;

describe("WebSocket transport (loopback)", () => {
  it("multiplexes a unary call and a subscription over one socket", async () => {
    // client.send -> session.handleMessage ; session.send -> client.receive
    const client = createWsClient<R>((d) =>
      queueMicrotask(() => session.handleMessage(d)),
    );
    const session = createWsSession(
      router,
      (d) => queueMicrotask(() => client.receive(d)),
      {},
    );

    expect(await client.api.add({ a: 3, b: 4 })).toBe(7);

    const out: number[] = [];
    for await (const n of client.api.ticks({ n: 3 })) out.push(n);
    expect(out).toEqual([0, 1, 2]);
  });
});

describe("WebSocket subscriptions stop their handler", () => {
  function waitingRouter(state: { aborted: boolean }) {
    return {
      watch: route.stream(async function* ({ signal }) {
        yield "ready";
        await new Promise<void>((r) => signal.addEventListener("abort", () => r()));
        state.aborted = true;
      }),
    } satisfies RouterRecord;
  }

  function loopback(r: object) {
    const client = createWsClient<ReturnType<typeof waitingRouter>>((d) =>
      queueMicrotask(() => session.handleMessage(d)),
    );
    const session = createWsSession(r, (d) => queueMicrotask(() => client.receive(d)), {});
    return { client, session };
  }

  it("on unsubscribe (breaking out of the loop)", async () => {
    const state = { aborted: false };
    const { client } = loopback(waitingRouter(state));
    for await (const _ of client.api.watch()) break;
    await new Promise((r) => setTimeout(r, 10));
    expect(state.aborted).toBe(true);
  });

  it("when the socket closes", async () => {
    const state = { aborted: false };
    const { client, session } = loopback(waitingRouter(state));
    const it = client.api.watch()[Symbol.asyncIterator]();
    await it.next();
    session.handleClose();
    await new Promise((r) => setTimeout(r, 10));
    expect(state.aborted).toBe(true);
  });
});

describe("WebSocket subscription cap", () => {
  it("refuses subscriptions over maxSubscriptions without starting them", async () => {
    let started = 0;
    const r = {
      forever: route.stream(async function* ({ signal }) {
        started++;
        yield "on";
        await new Promise<void>((res) => signal.addEventListener("abort", () => res()));
      }),
    } satisfies RouterRecord;
    const sent: { id: number; type: string; error?: { code?: string } }[] = [];
    const session = createWsSession(r, (d) => void sent.push(JSON.parse(d)), {}, { maxSubscriptions: 2 });
    const sub = (id: number) => session.handleMessage(JSON.stringify({ id, type: "subscribe", path: "forever" }));
    const tick = () => new Promise((res) => setTimeout(res, 5));

    sub(1);
    sub(2);
    sub(3);
    await tick();
    expect(started).toBe(2);
    expect(sent.filter((m) => m.id === 3)).toEqual([
      expect.objectContaining({ id: 3, type: "error", error: expect.objectContaining({ code: "TOO_MANY_REQUESTS" }) }),
    ]);

    session.handleMessage(JSON.stringify({ id: 1, type: "unsubscribe" }));
    sub(4);
    await tick();
    expect(started).toBe(3);
    session.handleClose();
  });
});
