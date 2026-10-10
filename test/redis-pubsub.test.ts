import { describe, it, expect } from "vitest";
import { createRedisPubSub, type RedisPubSubClient } from "../src/index.ts";

// A fake redis client: in-process pub/sub with per-channel listeners, enough to
// exercise the adapter's fan-out and ref-counted (un)subscribe without a server.
function fakeRedis() {
  const channels = new Map<string, Set<(m: string) => void>>();
  const subscribeCounts = new Map<string, number>();
  const client: RedisPubSubClient = {
    publish(channel, message) {
      for (const l of channels.get(channel) ?? []) l(message);
    },
    subscribe(channel, onMessage) {
      let set = channels.get(channel);
      if (!set) channels.set(channel, (set = new Set()));
      set.add(onMessage);
      subscribeCounts.set(channel, (subscribeCounts.get(channel) ?? 0) + 1);
    },
    unsubscribe(channel) {
      channels.delete(channel);
    },
  };
  return { client, subscribeCounts, channels };
}

describe("createRedisPubSub", () => {
  it("fans a published message out to multiple subscribers", async () => {
    const { client } = fakeRedis();
    const ps = createRedisPubSub(client);

    const a: unknown[] = [];
    const b: unknown[] = [];
    const ac = new AbortController();

    const subA = (async () => {
      for await (const m of ps.subscribe("room", { signal: ac.signal })) {
        a.push(m);
        if (a.length >= 2) break;
      }
    })();
    const subB = (async () => {
      for await (const m of ps.subscribe("room", { signal: ac.signal })) {
        b.push(m);
        if (b.length >= 2) break;
      }
    })();

    await new Promise((r) => setTimeout(r, 5));
    ps.publish("room", { n: 1 });
    ps.publish("room", { n: 2 });
    await Promise.all([subA, subB]);

    expect(a).toEqual([{ n: 1 }, { n: 2 }]);
    expect(b).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it("subscribes upstream once per channel and unsubscribes when the last leaves", async () => {
    const { client, subscribeCounts, channels } = fakeRedis();
    const ps = createRedisPubSub(client);

    const run = (tag: string, out: unknown[]) =>
      (async () => {
        for await (const m of ps.subscribe("c")) {
          out.push(m);
          break; // take one then leave
        }
      })();

    const o1: unknown[] = [];
    const o2: unknown[] = [];
    const p1 = run("1", o1);
    const p2 = run("2", o2);
    await new Promise((r) => setTimeout(r, 5));

    expect(subscribeCounts.get("c")).toBe(1); // one upstream subscription for two locals

    ps.publish("c", "hi");
    await Promise.all([p1, p2]);

    expect(o1).toEqual(["hi"]);
    expect(o2).toEqual(["hi"]);
    // both left → upstream channel removed
    expect(channels.has("c")).toBe(false);
  });
});
