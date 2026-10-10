// Redis-backed PubSub for multi-instance real-time (subscriptions fan out across
// every server process, not just one). Kept ZERO-DEPENDENCY: instead of importing
// a redis package, it takes a small structural client interface, so you wire your
// own client (node-redis v4 matches directly; ioredis needs a thin wrapper).
//
//   import { createClient } from "redis";
//   const pub = createClient(); const sub = pub.duplicate();
//   await pub.connect(); await sub.connect();
//   const pubsub = createRedisPubSub({
//     publish: (c, m) => pub.publish(c, m),
//     subscribe: (c, on) => sub.subscribe(c, on),
//     unsubscribe: (c) => sub.unsubscribe(c),
//   });
//
// It implements the same `PubSub` interface as the in-memory one, so procedures
// (publish on mutate, subscribe in a streaming handler) don't change.

import type { PubSub } from "./pubsub.ts";

export interface RedisPubSubClient {
  publish(channel: string, message: string): unknown;
  subscribe(channel: string, onMessage: (message: string) => void): unknown;
  unsubscribe(channel: string): unknown;
}

export function createRedisPubSub(client: RedisPubSubClient): PubSub {
  // Local fan-out per channel, with a single redis subscription per channel
  // (ref-counted) so N local subscribers share one upstream subscription.
  const topics = new Map<string, Set<(m: unknown) => void>>();

  return {
    publish(topic, message) {
      void client.publish(topic, JSON.stringify(message));
    },

    subscribe(topic, opts) {
      const queue: unknown[] = [];
      let wake: (() => void) | null = null;
      const push = (m: unknown) => {
        queue.push(m);
        wake?.();
        wake = null;
      };

      let listeners = topics.get(topic);
      if (!listeners) {
        listeners = new Set();
        topics.set(topic, listeners);
        // One upstream subscription per channel; parse + fan out locally.
        void client.subscribe(topic, (raw) => {
          let msg: unknown;
          try {
            msg = JSON.parse(raw);
          } catch {
            msg = raw;
          }
          for (const l of topics.get(topic) ?? []) l(msg);
        });
      }
      listeners.add(push);

      const signal = opts?.signal;
      signal?.addEventListener("abort", () => {
        wake?.();
        wake = null;
      });

      const cleanup = () => {
        const set = topics.get(topic);
        if (!set) return;
        set.delete(push);
        if (set.size === 0) {
          topics.delete(topic);
          void client.unsubscribe(topic);
        }
      };

      return {
        async *[Symbol.asyncIterator]() {
          try {
            while (!signal?.aborted) {
              if (queue.length) {
                yield queue.shift();
                continue;
              }
              await new Promise<void>((resolve) => {
                wake = resolve;
              });
            }
          } finally {
            cleanup();
          }
        },
      };
    },
  };
}
