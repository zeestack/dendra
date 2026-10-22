import { afterAll, describe, it, expect } from "vitest";
import {
  createInMemoryPubSub,
  createPgPubSub,
  createPubSub,
  createRedisPubSub,
  type PubSub,
  type PubSubTransport,
  type RedisPubSubClient,
} from "../src/index.ts";

const tick = () => new Promise((r) => setTimeout(r, 5));

// Takes `n` messages from a topic; subscribes synchronously, like a handler would.
function take(ps: PubSub, topic: string, n: number, signal?: AbortSignal) {
  const out: unknown[] = [];
  const done = (async () => {
    for await (const m of ps.subscribe(topic, { signal })) {
      out.push(m);
      if (out.length >= n) break;
    }
  })();
  return { out, done };
}

function fakeRedis(): RedisPubSubClient {
  const channels = new Map<string, (m: string) => void>();
  return {
    publish: (c, m) => channels.get(c)?.(m),
    subscribe: (c, on) => channels.set(c, on),
    unsubscribe: (c) => channels.delete(c),
  };
}

// Postgres joins when DENDRA_PG_URL points at a database; a fresh channel per
// instance so tests never hear each other.
const url = process.env.DENDRA_PG_URL;
const pool = url ? new (await import("pg")).default.Pool({ connectionString: url }) : undefined;
const pgs: { close(): Promise<void> }[] = [];
afterAll(async () => {
  await Promise.all(pgs.map((ps) => ps.close()));
  await pool?.end();
});
let channels = 0;
async function makePg() {
  const ps = createPgPubSub(pool!, { channel: `dendra_contract_${process.pid}_${channels++}` });
  pgs.push(ps);
  await ps.listen();
  return ps;
}

// Every backend must pass these. Add new transports here.
const backends: [string, () => PubSub | Promise<PubSub>][] = [
  ["in-memory", createInMemoryPubSub],
  ["redis", () => createRedisPubSub(fakeRedis())],
];
if (pool) backends.push(["postgres", makePg]);

describe.each(backends)("PubSub contract: %s", (_name, make) => {
  it("fans a message out to every subscriber of the topic", async () => {
    const ps = await make();
    const a = take(ps, "room", 2);
    const b = take(ps, "room", 2);
    ps.publish("room", { n: 1 });
    ps.publish("room", { n: 2 });
    await Promise.all([a.done, b.done]);
    expect(a.out).toEqual([{ n: 1 }, { n: 2 }]);
    expect(b.out).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it("keeps one publisher's messages in order", async () => {
    const ps = await make();
    const sent = Array.from({ length: 20 }, (_, i) => i);
    const a = take(ps, "t", sent.length);
    for (const i of sent) ps.publish("t", i);
    await a.done;
    expect(a.out).toEqual(sent);
  });

  it("keeps topics separate", async () => {
    const ps = await make();
    const a = take(ps, "a", 1);
    ps.publish("b", "wrong");
    ps.publish("a", "right");
    await a.done;
    expect(a.out).toEqual(["right"]);
  });

  it("ends the iteration when the signal aborts", async () => {
    const ps = await make();
    const ac = new AbortController();
    const a = take(ps, "t", 10, ac.signal);
    ps.publish("t", 1);
    while (a.out.length === 0) await tick(); // a network round trip for real transports
    ac.abort();
    await a.done;
    expect(a.out).toEqual([1]);
  });

  it("delivers to a new subscriber after the last one left", async () => {
    const ps = await make();
    await take(ps, "t", 1, AbortSignal.abort()).done;
    const b = take(ps, "t", 1);
    ps.publish("t", "again");
    await b.done;
    expect(b.out).toEqual(["again"]);
  });
});

describe("createPubSub", () => {
  function spyTransport() {
    const calls: string[] = [];
    const transport: PubSubTransport = {
      publish: () => {},
      subscribe: (t) => calls.push(`sub:${t}`),
      unsubscribe: (t) => calls.push(`unsub:${t}`),
    };
    return { calls, transport };
  }

  it("releases the upstream subscription when aborted before iteration", () => {
    const { calls, transport } = spyTransport();
    const ps = createPubSub(transport);
    const ac = new AbortController();
    ps.subscribe("t", { signal: ac.signal }); // never iterated
    ac.abort();
    expect(calls).toEqual(["sub:t", "unsub:t"]);
  });

  it("does not hold a topic for an already-aborted signal", () => {
    const { calls, transport } = spyTransport();
    createPubSub(transport).subscribe("t", { signal: AbortSignal.abort() });
    expect(calls).toEqual(["sub:t", "unsub:t"]);
  });
});

describe("createInMemoryPubSub", () => {
  it("passes messages through as-is, without a JSON round trip", async () => {
    const ps = createInMemoryPubSub();
    const msg = { at: new Date(0) };
    const a = take(ps, "t", 1);
    ps.publish("t", msg);
    await a.done;
    expect(a.out[0]).toBe(msg);
  });
});
