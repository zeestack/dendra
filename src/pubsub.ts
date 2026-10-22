// The one extra primitive multi-user real-time needs: fan-out. A mutation
// `publish`es; a streaming subscription procedure yields from `subscribe`. This
// is an INTERFACE with pluggable transports: the in-memory one is for a single
// process; Redis / Postgres LISTEN-NOTIFY / NATS give multi-instance fan-out
// without touching any procedure. Subscriptions honor an AbortSignal so a
// disconnect tears the subscription down.

export interface PubSub {
  publish(topic: string, message: unknown): void;
  subscribe(
    topic: string,
    opts?: { signal?: AbortSignal },
  ): AsyncIterable<unknown>;
}

/**
 * The backend-specific part of a PubSub: move a message to every process
 * subscribed to a topic. `createPubSub` subscribes upstream once per topic
 * (however many local subscribers it has) and unsubscribes when the last one
 * leaves. Encoding is the transport's job, so in-memory can pass objects as-is.
 */
export interface PubSubTransport {
  publish(topic: string, message: unknown): unknown;
  subscribe(topic: string, onMessage: (message: unknown) => void): unknown;
  unsubscribe(topic: string): unknown;
}

export function createPubSub(transport: PubSubTransport): PubSub {
  // Local fan-out per topic, sharing one upstream subscription.
  const topics = new Map<string, Set<(m: unknown) => void>>();

  return {
    publish(topic, message) {
      void transport.publish(topic, message);
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
        void transport.subscribe(topic, (m) => {
          for (const l of topics.get(topic) ?? []) l(m);
        });
      }
      listeners.add(push);

      let done = false;
      const cleanup = () => {
        if (done) return;
        done = true;
        signal?.removeEventListener("abort", onAbort);
        const set = topics.get(topic);
        if (!set) return;
        set.delete(push);
        if (set.size === 0) {
          topics.delete(topic);
          void transport.unsubscribe(topic);
        }
      };

      // Abort also cleans up, so a subscription that is never iterated
      // doesn't hold its listener (and upstream subscription) forever.
      const signal = opts?.signal;
      const onAbort = () => {
        cleanup();
        wake?.();
        wake = null;
      };
      if (signal?.aborted) cleanup();
      else signal?.addEventListener("abort", onAbort, { once: true });

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

export function createInMemoryPubSub(): PubSub {
  // Loopback transport: `createPubSub` holds one handler per topic.
  const handlers = new Map<string, (m: unknown) => void>();
  return createPubSub({
    publish: (topic, message) => handlers.get(topic)?.(message),
    subscribe: (topic, onMessage) => handlers.set(topic, onMessage),
    unsubscribe: (topic) => handlers.delete(topic),
  });
}
