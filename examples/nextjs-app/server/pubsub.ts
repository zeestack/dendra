// Single process → in-memory. For multiple server instances (or a standalone WS
// server alongside Next), swap this for a Redis/NATS-backed PubSub implementing
// the same interface — no procedure changes.
//
// Cached on `globalThis` so every route module instance in Next's dev server
// shares ONE bus (otherwise publishes and subscribes land on different copies).

import { createInMemoryPubSub, type PubSub } from "dendra";

const g = globalThis as unknown as { __nexusPubSub?: PubSub };

export const pubsub: PubSub = (g.__nexusPubSub ??= createInMemoryPubSub());
