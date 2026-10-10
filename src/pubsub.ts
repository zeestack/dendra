// The one extra primitive multi-user real-time needs: fan-out. A mutation
// `publish`es; a streaming subscription procedure yields from `subscribe`. This
// is an INTERFACE — the in-memory implementation is for a single process; swap
// in Redis / Postgres LISTEN-NOTIFY / NATS for multi-instance fan-out without
// touching any procedure. Subscriptions honor an AbortSignal so a disconnect
// tears the subscription down.

export interface PubSub {
  publish(topic: string, message: unknown): void;
  subscribe(
    topic: string,
    opts?: { signal?: AbortSignal },
  ): AsyncIterable<unknown>;
}

export function createInMemoryPubSub(): PubSub {
  const subs = new Map<string, Set<(m: unknown) => void>>();

  return {
    publish(topic, message) {
      const set = subs.get(topic);
      if (set) for (const fn of set) fn(message);
    },

    subscribe(topic, opts) {
      const queue: unknown[] = [];
      let wake: (() => void) | null = null;
      const push = (m: unknown) => {
        queue.push(m);
        wake?.();
        wake = null;
      };

      let set = subs.get(topic);
      if (!set) {
        set = new Set();
        subs.set(topic, set);
      }
      set.add(push);

      const signal = opts?.signal;
      signal?.addEventListener("abort", () => {
        wake?.();
        wake = null;
      });

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
            set!.delete(push);
          }
        },
      };
    },
  };
}
