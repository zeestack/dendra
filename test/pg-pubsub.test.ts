import { describe, it, expect, afterAll } from "vitest";
import {
  createPgPubSub,
  type PgListenClient,
  type PgNotification,
  type PgPool,
} from "../src/index.ts";

// A fake pg pool: NOTIFY is delivered to every connection that ran LISTEN on
// the channel, and a connection can be made to fail to exercise reconnects.
function fakePg() {
  type Conn = {
    client: PgListenClient;
    listening: Set<string>;
    released: boolean;
    emit(event: "notification", msg: PgNotification): void;
    emit(event: "error", err: Error): void;
    emit(event: "end"): void;
  };
  const conns: Conn[] = [];
  let failConnects = 0;

  const pool: PgPool & { failNext(n: number): void } = {
    async query(text, values) {
      if (text !== "SELECT pg_notify($1, $2)") return;
      const [channel, payload] = values as [string, string];
      for (const c of conns)
        if (!c.released && c.listening.has(channel)) c.emit("notification", { channel, payload });
    },
    async connect() {
      if (failConnects > 0) {
        failConnects--;
        throw new Error("connection refused");
      }
      const handlers = new Map<string, ((arg?: any) => void)[]>();
      const conn: Conn = {
        listening: new Set(),
        released: false,
        emit(event: string, arg?: unknown) {
          for (const h of handlers.get(event) ?? []) h(arg);
        },
        client: {
          async query(text: string) {
            const m = /^LISTEN "(\w+)"$/.exec(text);
            if (m) conn.listening.add(m[1]);
          },
          on(event: string, listener: (arg?: any) => void) {
            handlers.set(event, [...(handlers.get(event) ?? []), listener]);
          },
          release() {
            conn.released = true;
          },
        },
      };
      conns.push(conn);
      return conn.client;
    },
    failNext(n) {
      failConnects = n;
    },
  };
  return { pool, conns };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

function take(ps: ReturnType<typeof createPgPubSub>, topic: string, n: number) {
  const out: unknown[] = [];
  const done = (async () => {
    for await (const m of ps.subscribe(topic)) {
      out.push(m);
      if (out.length >= n) break;
    }
  })();
  return { out, done };
}

describe("createPgPubSub", () => {
  it("fans messages out by topic over one listening connection", async () => {
    const { pool, conns } = fakePg();
    const ps = createPgPubSub(pool);

    const a = take(ps, "a", 2);
    const a2 = take(ps, "a", 2);
    const b = take(ps, "b", 1);
    await ps.listen();

    await ps.publish("a", { n: 1 });
    await ps.publish("b", "hello");
    await ps.publish("a", { n: 2 });
    await Promise.all([a.done, a2.done, b.done]);

    expect(a.out).toEqual([{ n: 1 }, { n: 2 }]);
    expect(a2.out).toEqual([{ n: 1 }, { n: 2 }]);
    expect(b.out).toEqual(["hello"]);
    expect(conns).toHaveLength(1);
    expect([...conns[0].listening]).toEqual(["dendra"]);
    await ps.close();
  });

  it("reconnects with backoff when the listening connection is lost", async () => {
    const { pool, conns } = fakePg();
    const errors: unknown[] = [];
    const ps = createPgPubSub(pool, { backoff: { initialMs: 1 }, onError: (e) => errors.push(e) });
    const sub = take(ps, "t", 2);
    await ps.listen();

    await ps.publish("t", 1);
    pool.failNext(2); // the first two reconnect attempts fail
    conns[0].emit("error", new Error("terminated"));
    conns[0].emit("end");
    expect(conns[0].released).toBe(true);

    await ps.listen();
    expect(conns).toHaveLength(2);
    await ps.publish("t", 2);
    await sub.done;

    expect(sub.out).toEqual([1, 2]);
    expect(errors.map((e) => (e as Error).message)).toEqual([
      "terminated",
      "connection refused",
      "connection refused",
    ]);
    await ps.close();
  });

  it("ignores other channels and reports malformed payloads", async () => {
    const { pool, conns } = fakePg();
    const errors: unknown[] = [];
    const ps = createPgPubSub(pool, { channel: "app_events", onError: (e) => errors.push(e) });
    const sub = take(ps, "t", 1);
    await ps.listen();

    conns[0].emit("notification", { channel: "other", payload: '{"topic":"t","message":"no"}' });
    conns[0].emit("notification", { channel: "app_events", payload: "not json" });
    conns[0].emit("notification", { channel: "app_events", payload: '{"message":1}' });
    await ps.publish("t", "yes");
    await sub.done;

    expect(sub.out).toEqual(["yes"]);
    expect(errors).toHaveLength(2);
    await ps.close();
  });

  it("rejects messages over the NOTIFY payload limit before sending", () => {
    const { pool } = fakePg();
    const ps = createPgPubSub(pool);
    expect(() => ps.publish("t", "x".repeat(8000))).toThrow(/NOTIFY allows 7999/);
  });

  it("rejects channel names that are not plain identifiers", () => {
    const { pool } = fakePg();
    expect(() => createPgPubSub(pool, { channel: 'x"; DROP TABLE y; --' })).toThrow(/plain identifier/);
  });

  it("releases the connection on close and stops reconnecting", async () => {
    const { pool, conns } = fakePg();
    const ps = createPgPubSub(pool, { onError: () => {} });
    await ps.listen();
    await ps.close();
    expect(conns[0].released).toBe(true);
    conns[0].emit("end");
    await tick();
    expect(conns).toHaveLength(1);
    await expect(ps.listen()).rejects.toThrow(/closed/);
  });
});

// Against a real Postgres when DENDRA_PG_URL is set (CI runs one).
const url = process.env.DENDRA_PG_URL;
describe.skipIf(!url)("createPgPubSub (Postgres)", async () => {
  const pg = (await import("pg")).default;
  const pools: InstanceType<typeof pg.Pool>[] = [];
  const newPool = () => {
    const p = new pg.Pool({ connectionString: url });
    pools.push(p);
    return p;
  };
  afterAll(() => Promise.all(pools.map((p) => p.end())));

  it("delivers across processes (two pools) and from SQL", async () => {
    const one = createPgPubSub(newPool());
    const two = createPgPubSub(newPool());
    const sub = take(two, "notes", 2);
    await two.listen();

    await one.publish("notes", { id: 1 });
    await newPool().query(
      `SELECT pg_notify('dendra', json_build_object('topic', 'notes', 'message', json_build_object('id', 2))::text)`,
    );
    await sub.done;

    expect(sub.out).toEqual([{ id: 1 }, { id: 2 }]);
    await Promise.all([one.close(), two.close()]);
  });

  it("reconnects after the server kills the listening connection", async () => {
    const pool = newPool();
    const ps = createPgPubSub(pool, { backoff: { initialMs: 10 }, onError: () => {} });
    const sub = take(ps, "t", 1);
    await ps.listen();

    const killed = await newPool().query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE query = 'LISTEN "dendra"'`,
    );
    expect(killed.rowCount).toBe(1);
    await new Promise((r) => setTimeout(r, 200));
    await ps.listen();
    await ps.publish("t", "after");
    await sub.done;

    expect(sub.out).toEqual(["after"]);
    await ps.close();
  });
});
