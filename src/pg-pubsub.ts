// Postgres-backed PubSub on LISTEN/NOTIFY, for apps that already run Postgres
// and don't want Redis. Subscriptions fan out across every server process, and
// the database itself can publish (a trigger calling pg_notify). Kept
// ZERO-DEPENDENCY: it takes a structural pool, so a `pg.Pool` drops in.
//
//   import pg from "pg";
//   const pubsub = createPgPubSub(new pg.Pool({ connectionString }));
//
// Each process holds ONE listening connection (taken from the pool on the first
// subscribe, or by `listen()`), LISTENs on one channel, and fans messages out
// locally by topic. If that connection drops it reconnects with backoff;
// messages sent while it was down are lost, as with any pub/sub. One process's
// messages arrive in the order it published them.
//
// Every message travels as `{ "topic": …, "message": … }` JSON on that channel,
// so a trigger publishes with:
//
//   PERFORM pg_notify('dendra', json_build_object('topic', 'notes',
//                                                 'message', row_to_json(NEW))::text);
//
// NOTIFY payloads must be under 8000 bytes: publish an id and load the row,
// not the row itself, when it can be large.

import { createInMemoryPubSub, type PubSub } from "./pubsub.ts";

export interface PgNotification {
  channel: string;
  payload?: string;
}

/** The connection `createPgPubSub` LISTENs on (a `pg.PoolClient` matches). */
export interface PgListenClient {
  query(text: string): Promise<unknown>;
  on(event: "notification", listener: (msg: PgNotification) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  on(event: "end", listener: () => void): unknown;
  release(destroy?: Error | boolean): void;
}

/** What `createPgPubSub` needs from a pool (a `pg.Pool` matches). */
export interface PgPool {
  query(text: string, values?: unknown[]): Promise<unknown>;
  connect(): Promise<PgListenClient>;
}

export interface PgPubSubOptions {
  /** The NOTIFY channel every message travels on. Default `"dendra"`. */
  channel?: string;
  /** Reconnect delay: starts at `initialMs`, doubles up to `maxMs`. Default 100 ms → 30 s. */
  backoff?: { initialMs?: number; maxMs?: number };
  /** Lost connections, failed publishes, malformed payloads. Default: `console.error`. */
  onError?: (err: unknown) => void;
}

export interface PgPubSub extends PubSub {
  /** Resolves once NOTIFYs are sent (failures also go to `onError`). */
  publish(topic: string, message: unknown): Promise<void>;
  /** Connect the listening connection now instead of on the first subscribe. Resolves once LISTEN is active. */
  listen(): Promise<void>;
  /** Release the listening connection and stop reconnecting. */
  close(): Promise<void>;
}

/** Postgres rejects NOTIFY payloads of 8000 bytes or more. */
const MAX_PAYLOAD_BYTES = 7999;

export function createPgPubSub(pool: PgPool, opts: PgPubSubOptions = {}): PgPubSub {
  const channel = opts.channel ?? "dendra";
  if (!/^[a-z_][a-z0-9_]*$/i.test(channel)) {
    throw new Error(`[dendra] pg pubsub: channel '${channel}' must be a plain identifier`);
  }
  const initialMs = opts.backoff?.initialMs ?? 100;
  const maxMs = opts.backoff?.maxMs ?? 30_000;
  const report = opts.onError ?? ((e: unknown) => console.error("[dendra] pg pubsub:", e));
  const encoder = new TextEncoder();
  const local = createInMemoryPubSub();

  let client: PgListenClient | null = null;
  let starting: Promise<void> | null = null;
  let closed = false;
  let cancelWait: (() => void) | null = null;
  let queue: Promise<void> = Promise.resolve();

  const wait = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      cancelWait = () => {
        clearTimeout(timer);
        resolve();
      };
    });

  const onNotification = (msg: PgNotification) => {
    if (msg.channel !== channel) return;
    let parsed: { topic?: unknown; message?: unknown };
    try {
      parsed = JSON.parse(msg.payload ?? "");
    } catch {
      report(new Error(`pg pubsub: payload on '${channel}' is not JSON: ${msg.payload}`));
      return;
    }
    if (typeof parsed?.topic !== "string") {
      report(new Error(`pg pubsub: payload on '${channel}' has no string "topic": ${msg.payload}`));
      return;
    }
    local.publish(parsed.topic, parsed.message);
  };

  // A listening connection failed or ended: destroy it and start over.
  const lost = (c: PgListenClient, err?: Error) => {
    if (client !== c) return; // already handled (pg emits "error" then "end")
    client = null;
    c.release(err ?? true);
    report(err ?? new Error("pg pubsub: listening connection ended"));
    if (!closed) starting = connect();
  };

  async function connect(): Promise<void> {
    let delay = initialMs;
    while (!closed) {
      let c: PgListenClient | null = null;
      try {
        c = await pool.connect();
        const conn = c;
        conn.on("notification", onNotification);
        conn.on("error", (err) => lost(conn, err));
        conn.on("end", () => lost(conn));
        await conn.query(`LISTEN "${channel}"`);
        if (closed) {
          conn.release(true);
          return;
        }
        client = conn;
        return;
      } catch (err) {
        // Destroyed, never returned to the pool: it still has our listeners.
        c?.release(err instanceof Error ? err : true);
        report(err);
        await wait(delay);
        delay = Math.min(delay * 2, maxMs);
      }
    }
  }

  const listen = () => {
    if (closed) return Promise.reject(new Error("[dendra] pg pubsub is closed"));
    return (starting ??= connect());
  };

  return {
    publish(topic, message) {
      const payload = JSON.stringify({ topic, message });
      const bytes = encoder.encode(payload).length;
      if (bytes > MAX_PAYLOAD_BYTES) {
        throw new RangeError(
          `[dendra] pg pubsub: message for '${topic}' is ${bytes} bytes; NOTIFY allows ${MAX_PAYLOAD_BYTES}. Publish an id and load the rest.`,
        );
      }
      // One at a time: pooled queries race, and order matters (running → succeeded).
      const sent = queue.then(() => pool.query("SELECT pg_notify($1, $2)", [channel, payload])).then(() => {});
      queue = sent.catch(() => {});
      sent.catch(report);
      return sent;
    },

    subscribe(topic, subOpts) {
      listen().catch(report);
      return local.subscribe(topic, subOpts);
    },

    listen,

    async close() {
      closed = true;
      cancelWait?.();
      await starting;
      const c = client;
      client = null;
      c?.release(true);
    },
  };
}
