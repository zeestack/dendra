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
