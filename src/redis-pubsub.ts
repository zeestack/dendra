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

import { createPubSub, type PubSub } from "./pubsub.ts";

export interface RedisPubSubClient {
  publish(channel: string, message: string): unknown;
  subscribe(channel: string, onMessage: (message: string) => void): unknown;
  unsubscribe(channel: string): unknown;
}

export function createRedisPubSub(client: RedisPubSubClient): PubSub {
  // Redis carries strings: JSON on the way out, parse (raw if not JSON) on the way in.
  return createPubSub({
    publish: (topic, message) => client.publish(topic, JSON.stringify(message)),
    subscribe: (topic, onMessage) =>
      client.subscribe(topic, (raw) => {
        let msg: unknown;
        try {
          msg = JSON.parse(raw);
        } catch {
          msg = raw;
        }
        onMessage(msg);
      }),
    unsubscribe: (topic) => client.unsubscribe(topic),
  });
}
