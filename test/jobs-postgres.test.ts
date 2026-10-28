import { describe, it, expect, afterAll } from "vitest";
import { createJobs, createInMemoryPubSub, createPgJobStore, createPgPubSub, s } from "../src/index.ts";
import type { NewJob } from "../src/jobs.ts";
import { enqueueDueSchedules, type NewSchedule } from "../src/job-schedules.ts";

// The production setup: jobs on the Postgres store, status over Postgres
// pub/sub, with the web process and the worker as separate "processes".
const url = process.env.DENDRA_PG_URL;

describe.skipIf(!url)("jobs on Postgres (store + pub/sub)", async () => {
  const pg = (await import("pg")).default;
  const pools: InstanceType<typeof pg.Pool>[] = [];
  const newPool = () => {
    const p = new pg.Pool({ connectionString: url });
    pools.push(p);
    return p;
  };
  const table = `dendra_jobs_e2e_${process.pid}`;
  const tables = new Set([table]);
  afterAll(async () => {
    for (const name of tables) {
      await pools[0]?.query(`DROP TABLE IF EXISTS "${name}_schedules"`);
      await pools[0]?.query(`DROP TABLE IF EXISTS "${name}"`);
    }
    await Promise.all(pools.map((p) => p.end()));
  });

  const isolated = async (suffix: string, setup = true) => {
    const name = `dendra_jobs_pg_${process.pid}_${suffix}`;
    tables.add(name);
    const pool = newPool();
    const store = createPgJobStore(pool, { table: name });
    if (setup) await store.setup();
    return { pool, store, table: name };
  };
  const job = (id: string, more: Partial<NewJob> = {}): NewJob => ({
    id, name: "daily", key: null, input: { tenant: "a" }, maxAttempts: 3, runAt: Date.now() - 1000, ...more,
  });
  const schedule = (id: string, more: Partial<NewSchedule> = {}): NewSchedule => ({
    id, name: "daily", key: null, input: { tenant: "a" }, maxAttempts: 3,
    calendar: { kind: "daily", hourUTC: 9, minuteUTC: 0 }, nextRunAt: Date.now() - 1000, ...more,
  });

  // One process's view: its own pool, store and pub/sub on a shared table and channel.
  const process_ = async () => {
    const pool = newPool();
    const store = createPgJobStore(pool, { table });
    await store.setup();
    const pubsub = createPgPubSub(pool, { channel: "dendra_jobs_e2e" });
    await pubsub.listen();
    const jobs = createJobs({ store, pubsub, context: () => ({}), pollMs: 20, leaseMs: 1000 });
    const add = jobs.define("add", {
      input: s.object({ a: s.number(), b: s.number() }),
      run: ({ input }) => input.a + input.b,
    });
    return { jobs, add, pubsub };
  };

  it("streams a job's status from the worker to the web process in order", async () => {
    const web = await process_();
    const worker = await process_();

    const { jobId } = await web.add.enqueue({ a: 2, b: 3 });
    const seen: { status: string; version: number; result?: unknown }[] = [];
    const watching = (async () => {
      for await (const snap of web.add.watch(jobId)) seen.push(snap);
    })();
    // Start the worker only once watch has read the job, so "queued" is seen.
    while (seen.length === 0) await new Promise((r) => setTimeout(r, 5));
    worker.jobs.start();
    await watching;

    expect(seen.map((x) => x.status)).toEqual(["queued", "running", "succeeded"]);
    expect(seen.map((x) => x.version)).toEqual([1, 2, 3]);
    expect(seen.at(-1)?.result).toBe(5);

    await worker.jobs.stop();
    await Promise.all([web.pubsub.close(), worker.pubsub.close()]);
  });

  it("upgrades a populated 0.9 queue additively and preserves legacy defaults", async () => {
    const { pool, store, table } = await isolated("legacy", false);
    await pool.query(`CREATE TABLE "${table}" (
      id text PRIMARY KEY, name text NOT NULL, key text, input jsonb, status text NOT NULL,
      attempt integer NOT NULL DEFAULT 0, version integer NOT NULL DEFAULT 1,
      max_attempts integer NOT NULL, progress jsonb, result jsonb, error jsonb,
      run_at timestamptz NOT NULL, locked_until timestamptz, token text,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    )`);
    await pool.query(`INSERT INTO "${table}" (id, name, input, status, max_attempts, run_at, result)
      VALUES ('old-queued', 'legacy', '{"kept":true}', 'queued', 3, now(), NULL),
             ('old-finished', 'legacy', '{}', 'succeeded', 3, now(), '42')`);
    await store.setup();
    await store.setup();
    expect(store.capabilities).toEqual({ executionPolicies: true, schedules: true });
    expect(await store.get("old-finished")).toMatchObject({ status: "succeeded", result: 42 });
    expect(await store.claim(["legacy"], "worker", 10_000)).toMatchObject({
      id: "old-queued", input: { kept: true }, attempt: 1, onInterrupt: "retry", deadlineAt: null, interrupted: false,
    });
    expect((await store.get("old-queued"))?.timeoutMs).toBeUndefined();
    expect(await store.extend("old-queued", "worker", 10_000)).toBe(true);
    expect(await store.settle("old-queued", "worker", { status: "succeeded", result: "kept" }))
      .toMatchObject({ status: "succeeded", result: "kept" });
  });

  it("persists execution policy and atomically identifies an interrupted deadline claim", async () => {
    const { pool, store, table } = await isolated("policy");
    await store.add(job("paid", { timeoutMs: 60_000, onInterrupt: "fail" }));
    const first = await store.claim(["daily"], "old", 120_000);
    expect(first).toMatchObject({ id: "paid", timeoutMs: 60_000, onInterrupt: "fail", interrupted: false, attempt: 1 });
    expect(first?.deadlineAt).toBeGreaterThan(Date.now() + 55_000);
    // The lease is still live: the execution deadline alone must make it recoverable.
    await pool.query(`UPDATE "${table}" SET deadline_at = now() - interval '1 second' WHERE id = 'paid'`);
    expect(await store.extend("paid", "old", 120_000)).toBe(false);
    expect(await store.progress("paid", "old", "too late")).toBeNull();
    expect(await store.settle("paid", "old", { status: "succeeded", result: "too late" })).toBeNull();
    const recovered = await store.claim(["daily"], "new", 120_000);
    expect(recovered).toMatchObject({ id: "paid", timeoutMs: 60_000, onInterrupt: "fail", interrupted: true, attempt: 2 });
    expect(recovered?.deadlineAt).toBeGreaterThan(Date.now() + 55_000);
    expect(await store.progress("paid", "old", "stale")).toBeNull();
    expect(await store.settle("paid", "old", { status: "succeeded", result: "stale" })).toBeNull();
    const failed = await store.settle("paid", "new", { status: "failed", error: { code: "INTERNAL", message: "Interrupted" } });
    expect(failed).toMatchObject({ status: "failed", deadlineAt: null });
    expect(failed?.interrupted).toBeUndefined(); // Recovery metadata belongs to the claim, not persisted state.
  });

  it("keeps lease recovery and retry defaults for jobs without execution policies", async () => {
    const { pool, store, table } = await isolated("recovery");
    await store.add(job("legacy"));
    await store.claim(["daily"], "old", 60_000);
    await pool.query(`UPDATE "${table}" SET locked_until = now() - interval '1 second' WHERE id = 'legacy'`);
    expect(await store.claim(["daily"], "new", 60_000)).toMatchObject({
      id: "legacy", onInterrupt: "retry", deadlineAt: null, interrupted: true, attempt: 2,
    });
    expect(await store.settle("legacy", "new", { status: "queued", error: null, runAt: Date.now() - 1, refund: true }))
      .toMatchObject({ status: "queued", deadlineAt: null, attempt: 1 });
    expect(await store.claim(["daily"], "third", 60_000)).toMatchObject({ interrupted: false, attempt: 2 });
  });

  it("fails an interrupted paid job before rebuilding context or replaying its handler", async () => {
    const { pool, store, table } = await isolated("no_replay");
    await store.add(job("paid", { name: "paid", maxAttempts: 10, timeoutMs: 60_000, onInterrupt: "fail" }));
    await store.claim(["paid"], "crashed-worker", 60_000);
    await pool.query(`UPDATE "${table}" SET locked_until = now() - interval '1 second' WHERE id = 'paid'`);
    let contexts = 0;
    let calls = 0;
    const worker = createJobs({
      store, pubsub: createInMemoryPubSub(), context: () => { contexts++; return {}; }, pollMs: 10,
    });
    worker.define("paid", { run: () => { calls++; return "must not run"; } });
    worker.start();
    try {
      await expect.poll(async () => (await store.get("paid"))?.status).toBe("failed");
      expect(await store.get("paid")).toMatchObject({ attempt: 2, maxAttempts: 10, onInterrupt: "fail", deadlineAt: null });
      expect(contexts).toBe(0);
      expect(calls).toBe(0);
    } finally {
      await worker.stop();
    }
  });

  it("enqueues one occurrence when independent schedulers compete for the same cursor", async () => {
    const { pool, store, table } = await isolated("race");
    const other = createPgJobStore(newPool(), { table });
    const record = await store.putSchedule(schedule("race", { timeoutMs: 12_000, onInterrupt: "fail" }));
    const nextAt = Date.now() + 86_400_000;
    // Hold the row until both statements are waiting: connection startup must
    // not accidentally turn this into two sequential calls.
    const blocker = await pool.connect();
    await blocker.query("BEGIN");
    await blocker.query(`SELECT id FROM "${table}_schedules" WHERE id = $1 FOR UPDATE`, [record.id]);
    let competing: Promise<boolean[]>;
    try {
      competing = Promise.all([
        store.advanceSchedule(record, nextAt, job("occurrence-a", { timeoutMs: 12_000, onInterrupt: "fail" })),
        other.advanceSchedule(record, nextAt, job("occurrence-b", { timeoutMs: 12_000, onInterrupt: "fail" })),
      ]);
      await expect.poll(async () => {
        const { rows } = await pool.query(`SELECT count(*)::int AS waiting FROM pg_stat_activity
          WHERE wait_event_type = 'Lock' AND query LIKE $1`, [`%WITH due AS%${table}_schedules%`]);
        return rows[0].waiting;
      }).toBe(2);
    } finally {
      await blocker.query("COMMIT");
      blocker.release();
    }
    const outcomes = await competing!;
    expect(outcomes.sort()).toEqual([false, true]);
    const { rows } = await pool.query(`SELECT id, timeout_ms, on_interrupt FROM "${table}"`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ timeout_ms: "12000", on_interrupt: "fail" });
    expect(await store.dueSchedules(["daily"], Date.now())).toEqual([]);
    expect(await store.advanceSchedule(record, nextAt, job("stale"))).toBe(false);
  });

  it("preserves identical schedules and fences changes, removal and recreation", async () => {
    const { pool, store, table } = await isolated("revision");
    const original = schedule("stable");
    const first = await store.putSchedule(original);
    const same = await store.putSchedule({ ...original, nextRunAt: original.nextRunAt + 60_000 });
    expect(same.revision).toBe(first.revision);
    expect(same.nextRunAt).toBe(first.nextRunAt);
    const changed = await store.putSchedule({ ...original, input: { tenant: "b" }, nextRunAt: original.nextRunAt + 60_000 });
    expect(changed.revision).toBeGreaterThan(first.revision);
    expect(changed.nextRunAt).toBe(original.nextRunAt + 60_000);
    expect(await store.advanceSchedule(first, Date.now() + 86_400_000, job("before-edit"))).toBe(false);
    expect(await store.removeSchedule(original.id)).toBe(true);
    expect(await store.advanceSchedule(changed, Date.now() + 86_400_000, job("before-remove"))).toBe(false);
    const recreated = await store.putSchedule(original);
    expect(recreated.revision).toBeGreaterThan(changed.revision);
    expect(await store.advanceSchedule(first, Date.now() + 86_400_000, job("before-recreate"))).toBe(false);
    expect((await pool.query(`SELECT id FROM "${table}"`)).rows).toHaveLength(0);
  });

  it("consumes an occurrence when its active key is already queued, without a backlog burst", async () => {
    const { pool, store, table } = await isolated("dedupe");
    await store.add(job("active", { key: "tenant-a" }));
    const record = await store.putSchedule(schedule("dedupe", { key: "tenant-a", nextRunAt: Date.now() - 7 * 86_400_000 }));
    const nextAt = Date.now() + 86_400_000;
    expect(await store.advanceSchedule(record, nextAt, job("duplicate", { key: "tenant-a" }))).toBe(true);
    expect(await store.dueSchedules(["daily"], Date.now())).toEqual([]);
    expect((await pool.query(`SELECT id FROM "${table}"`)).rows).toEqual([{ id: "active" }]);
  });

  it("loads persisted schedules in a new process view and queues one catch-up with its policies", async () => {
    const { pool, store, table } = await isolated("catchup");
    await store.putSchedule(schedule("persisted", {
      nextRunAt: Date.now() - 7 * 86_400_000, key: "tenant-b", input: { tenant: "b", include: [1, 2] },
      maxAttempts: 7, timeoutMs: 180_000, onInterrupt: "fail",
    }));
    const restarted = createPgJobStore(newPool(), { table });
    const now = Date.now();
    expect(await enqueueDueSchedules(restarted, ["daily"], now)).toBe(1);
    expect(await enqueueDueSchedules(restarted, ["daily"], now)).toBe(0);
    const { rows } = await pool.query(`SELECT id FROM "${table}"`);
    expect(rows).toHaveLength(1);
    expect(await restarted.get(rows[0].id)).toMatchObject({
      input: { tenant: "b", include: [1, 2] }, key: "tenant-b", maxAttempts: 7,
      timeoutMs: 180_000, onInterrupt: "fail", runAt: now,
    });
  });

  it("rolls back the cursor if enqueue fails, and filters due schedules by worker name and limit", async () => {
    const { store } = await isolated("rollback");
    const past = Date.now() - 1000;
    const record = await store.putSchedule(schedule("first", { nextRunAt: past - 1000 }));
    await store.putSchedule(schedule("second", { nextRunAt: past }));
    await store.putSchedule(schedule("other", { name: "elsewhere", nextRunAt: past - 2000 }));
    await store.putSchedule(schedule("future", { nextRunAt: Date.now() + 60_000 }));
    expect((await store.dueSchedules(["daily"], Date.now(), 1)).map((s) => s.id)).toEqual(["first"]);
    expect((await store.dueSchedules(["daily"], Date.now())).map((s) => s.id)).toEqual(["first", "second"]);
    await store.add(job("taken"));
    await expect(store.advanceSchedule(record, Date.now() + 60_000, job("taken"))).rejects.toThrow();
    const after = (await store.dueSchedules(["daily"], Date.now(), 1))[0];
    expect(after.nextRunAt).toBe(record.nextRunAt);
    expect(after.revision).toBe(record.revision);
    expect(await store.advanceSchedule(record, Date.now() + 60_000, job("valid"))).toBe(true);
  });
});
