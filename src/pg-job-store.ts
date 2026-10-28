// A Postgres JobStore: jobs survive deploys and crashes, and any number of
// worker processes share the queue. Workers claim with FOR UPDATE SKIP LOCKED,
// so two never take the same job. Kept ZERO-DEPENDENCY: it takes a structural
// pool, so a `pg.Pool` drops in.
//
//   const store = createPgJobStore(pool);
//   await store.setup();   // Owner-run additive migration; or copy store.schema into your migration
//
// Finished jobs stay in the table (status, result, error) until you delete them,
// e.g. `DELETE FROM dendra_jobs WHERE status IN ('succeeded','failed') AND updated_at < now() - interval '7 days'`.

import type { JobRecord, JobStore } from "./jobs.ts";
import type { JobScheduleStore, ScheduleRecord } from "./job-schedules.ts";

/** What `createPgJobStore` needs from a pool (a `pg.Pool` matches). */
export interface PgQueryable {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}

export interface PgJobStore extends JobStore {
  putSchedule: JobScheduleStore["putSchedule"];
  removeSchedule: JobScheduleStore["removeSchedule"];
  dueSchedules: JobScheduleStore["dueSchedules"];
  advanceSchedule: JobScheduleStore["advanceSchedule"];
  /** Additive CREATE/ALTER statements, for an owner-run migration. */
  readonly schema: string[];
  /** Run `schema` (idempotent). */
  setup(): Promise<void>;
}

type Row = {
  id: string;
  name: string;
  key: string | null;
  input: unknown;
  status: JobRecord["status"];
  attempt: number;
  version: number;
  max_attempts: number;
  progress: unknown;
  result: unknown;
  error: JobRecord["error"];
  run_at: Date;
  timeout_ms: string | number | null;
  on_interrupt: "retry" | "fail";
  deadline_at: Date | null;
  interrupted?: boolean;
};

const toRecord = (r: Row): JobRecord => ({
  id: r.id,
  name: r.name,
  key: r.key,
  input: r.input,
  status: r.status,
  attempt: r.attempt,
  version: r.version,
  maxAttempts: r.max_attempts,
  progress: r.progress,
  result: r.result,
  error: r.error,
  runAt: r.run_at.getTime(),
  timeoutMs: r.timeout_ms == null ? undefined : Number(r.timeout_ms),
  onInterrupt: r.on_interrupt,
  deadlineAt: r.deadline_at?.getTime() ?? null,
  ...(r.interrupted === undefined ? {} : { interrupted: r.interrupted }),
});

type ScheduleRow = {
  id: string;
  name: string;
  key: string | null;
  input: unknown;
  max_attempts: number;
  timeout_ms: string | number | null;
  on_interrupt: "retry" | "fail";
  calendar: ScheduleRecord["calendar"];
  next_run_at: Date;
  revision: string | number;
};

const toSchedule = (r: ScheduleRow): ScheduleRecord => ({
  id: r.id,
  name: r.name,
  key: r.key,
  input: r.input,
  maxAttempts: r.max_attempts,
  timeoutMs: r.timeout_ms == null ? undefined : Number(r.timeout_ms),
  onInterrupt: r.on_interrupt,
  calendar: r.calendar,
  nextRunAt: r.next_run_at.getTime(),
  revision: Number(r.revision),
});

// jsonb parameters go in as text; `undefined` becomes SQL null.
const json = (v: unknown) => (v === undefined ? null : JSON.stringify(v));

export function createPgJobStore(pool: PgQueryable, opts: { table?: string } = {}): PgJobStore {
  const table = opts.table ?? "dendra_jobs";
  if (!/^[a-z_][a-z0-9_]*$/i.test(table)) {
    throw new Error(`[dendra] pg job store: table '${table}' must be a plain identifier`);
  }
  const t = `"${table}"`;
  const schedules = `"${table}_schedules"`;
  const revisions = `"${table}_schedule_revision"`;
  const ACTIVE = `status IN ('queued', 'running')`;
  const schema = [
    `CREATE TABLE IF NOT EXISTS ${t} (
      id text PRIMARY KEY,
      name text NOT NULL,
      key text,
      input jsonb,
      status text NOT NULL,
      attempt integer NOT NULL DEFAULT 0,
      version integer NOT NULL DEFAULT 1,
      max_attempts integer NOT NULL,
      timeout_ms bigint,
      on_interrupt text NOT NULL DEFAULT 'retry',
      deadline_at timestamptz,
      progress jsonb,
      result jsonb,
      error jsonb,
      run_at timestamptz NOT NULL,
      locked_until timestamptz,
      token text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`,
    // CREATE IF NOT EXISTS alone would leave an existing 0.9 queue unchanged.
    `ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS timeout_ms bigint`,
    `ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS on_interrupt text NOT NULL DEFAULT 'retry'`,
    `ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS deadline_at timestamptz`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "${table}_active_key" ON ${t} (name, key) WHERE key IS NOT NULL AND ${ACTIVE}`,
    `CREATE INDEX IF NOT EXISTS "${table}_runnable" ON ${t} (name, run_at) WHERE ${ACTIVE}`,
    // A sequence fences delete/recreate as well as edits; restarting at revision
    // one would let a stale scheduler advance a newly created schedule.
    `CREATE SEQUENCE IF NOT EXISTS ${revisions}`,
    `CREATE TABLE IF NOT EXISTS ${schedules} (
      id text PRIMARY KEY,
      name text NOT NULL,
      key text,
      input jsonb,
      max_attempts integer NOT NULL,
      timeout_ms bigint,
      on_interrupt text NOT NULL DEFAULT 'retry',
      calendar jsonb NOT NULL,
      next_run_at timestamptz NOT NULL,
      revision bigint NOT NULL DEFAULT nextval('${revisions}'::regclass)
    )`,
    `ALTER SEQUENCE ${revisions} OWNED BY ${schedules}.revision`,
    `CREATE INDEX IF NOT EXISTS "${table}_schedules_due" ON ${schedules} (name, next_run_at)`,
  ];

  const one = async (text: string, values: unknown[]) => {
    const { rows } = await pool.query(text, values);
    return rows.length ? toRecord(rows[0] as Row) : null;
  };

  return {
    capabilities: { executionPolicies: true, schedules: true },
    schema,

    async setup() {
      for (const stmt of schema) await pool.query(stmt);
    },

    async add(job) {
      // The insert loses to an active job with the same key; if that job
      // finishes before we read it, try again.
      for (let i = 0; i < 3; i++) {
        const { rows } = await pool.query(
          `INSERT INTO ${t} (id, name, key, input, status, max_attempts, run_at, timeout_ms, on_interrupt)
           VALUES ($1, $2, $3, $4::jsonb, 'queued', $5, to_timestamp($6 / 1000.0), $7, $8)
           ON CONFLICT (name, key) WHERE key IS NOT NULL AND ${ACTIVE} DO NOTHING
           RETURNING id`,
          [job.id, job.name, job.key, json(job.input), job.maxAttempts, job.runAt, job.timeoutMs ?? null, job.onInterrupt ?? "retry"],
        );
        if (rows.length) return { id: job.id, created: true };
        const existing = await pool.query(
          `SELECT id FROM ${t} WHERE name = $1 AND key = $2 AND ${ACTIVE}`,
          [job.name, job.key],
        );
        if (existing.rows.length) return { id: (existing.rows[0] as { id: string }).id, created: false };
      }
      throw new Error(`[dendra] pg job store: could not enqueue '${job.name}' (key '${job.key}')`);
    },

    claim(names, token, leaseMs) {
      return one(
        `WITH candidate AS (
           SELECT id, status = 'running' AS interrupted FROM ${t}
           WHERE name = ANY($1)
             AND ((status = 'queued' AND run_at <= now()) OR
               (status = 'running' AND (locked_until < now() OR deadline_at <= now())))
           ORDER BY run_at, created_at
           LIMIT 1
           FOR UPDATE SKIP LOCKED
         )
         UPDATE ${t} AS job
         SET status = 'running', attempt = job.attempt + 1, version = job.version + 1, token = $2,
             locked_until = now() + $3 * interval '1 millisecond',
             deadline_at = now() + job.timeout_ms * interval '1 millisecond', updated_at = now()
         FROM candidate WHERE job.id = candidate.id
         RETURNING job.*, candidate.interrupted`,
        [names, token, leaseMs],
      );
    },

    async extend(id, token, leaseMs) {
      const { rows } = await pool.query(
        `UPDATE ${t} SET locked_until = now() + $3 * interval '1 millisecond', updated_at = now()
         WHERE id = $1 AND token = $2 AND status = 'running'
           AND (deadline_at IS NULL OR deadline_at > now()) RETURNING id`,
        [id, token, leaseMs],
      );
      return rows.length > 0;
    },

    async progress(id, token, progress) {
      const { rows } = await pool.query(
        `UPDATE ${t} SET progress = $3::jsonb, version = version + 1, updated_at = now()
         WHERE id = $1 AND token = $2 AND status = 'running'
           AND (deadline_at IS NULL OR deadline_at > now()) RETURNING version`,
        [id, token, json(progress)],
      );
      return rows.length ? (rows[0] as { version: number }).version : null;
    },

    settle(id, token, outcome) {
      const owned = `WHERE id = $1 AND token = $2 AND status = 'running' RETURNING *`;
      const cleared = `token = NULL, locked_until = NULL, deadline_at = NULL, version = version + 1, updated_at = now()`;
      if (outcome.status === "succeeded") {
        return one(
          `UPDATE ${t} SET status = 'succeeded', result = $3::jsonb, error = NULL, ${cleared}
           WHERE id = $1 AND token = $2 AND status = 'running'
             AND (deadline_at IS NULL OR deadline_at > now()) RETURNING *`,
          [id, token, json(outcome.result)],
        );
      }
      if (outcome.status === "failed") {
        return one(`UPDATE ${t} SET status = 'failed', error = $3::jsonb, ${cleared} ${owned}`, [
          id,
          token,
          json(outcome.error),
        ]);
      }
      return one(
        `UPDATE ${t} SET status = 'queued', error = $3::jsonb, run_at = to_timestamp($4 / 1000.0),
           attempt = attempt - $5, ${cleared} ${owned}`,
        [id, token, json(outcome.error), outcome.runAt, outcome.refund ? 1 : 0],
      );
    },

    get(id) {
      return one(`SELECT * FROM ${t} WHERE id = $1`, [id]);
    },

    async putSchedule(schedule) {
      const changed = `(current.name, current.key, current.input, current.max_attempts,
        current.timeout_ms, current.on_interrupt, current.calendar) IS DISTINCT FROM
        (excluded.name, excluded.key, excluded.input, excluded.max_attempts,
        excluded.timeout_ms, excluded.on_interrupt, excluded.calendar)`;
      const { rows } = await pool.query(
        `INSERT INTO ${schedules} AS current
           (id, name, key, input, max_attempts, timeout_ms, on_interrupt, calendar, next_run_at)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8::jsonb, to_timestamp($9 / 1000.0))
         ON CONFLICT (id) DO UPDATE SET
           name = excluded.name, key = excluded.key, input = excluded.input,
           max_attempts = excluded.max_attempts, timeout_ms = excluded.timeout_ms,
           on_interrupt = excluded.on_interrupt, calendar = excluded.calendar,
           next_run_at = CASE WHEN ${changed} THEN excluded.next_run_at ELSE current.next_run_at END,
           revision = CASE WHEN ${changed} THEN nextval('${revisions}'::regclass) ELSE current.revision END
         RETURNING *`,
        [schedule.id, schedule.name, schedule.key, json(schedule.input), schedule.maxAttempts,
          schedule.timeoutMs ?? null, schedule.onInterrupt ?? "retry", json(schedule.calendar), schedule.nextRunAt],
      );
      return toSchedule(rows[0] as ScheduleRow);
    },

    async removeSchedule(id) {
      const { rows } = await pool.query(`DELETE FROM ${schedules} WHERE id = $1 RETURNING id`, [id]);
      return rows.length > 0;
    },

    async dueSchedules(names, now, limit = 100) {
      const { rows } = await pool.query(
        `SELECT * FROM ${schedules} WHERE name = ANY($1) AND next_run_at <= to_timestamp($2 / 1000.0)
         ORDER BY next_run_at, id LIMIT $3`,
        [names, now, limit],
      );
      return rows.map((row) => toSchedule(row as ScheduleRow));
    },

    async advanceSchedule(schedule, nextAt, job) {
      if (!Number.isFinite(nextAt) || nextAt <= schedule.nextRunAt) {
        throw new RangeError("[dendra] pg job store: the next occurrence must advance the schedule");
      }
      // One statement is one transaction, even for a structural pool that has
      // no connect(). Lock/recheck the cursor before either enqueue or advance.
      // Dedupe consumes this occurrence too: never accumulate a missed backlog.
      const { rows } = await pool.query(
        `WITH due AS (
           SELECT id FROM ${schedules}
           WHERE id = $1 AND revision = $2 AND next_run_at = to_timestamp($3 / 1000.0)
           FOR UPDATE
         ), advanced AS (
           UPDATE ${schedules} AS schedule SET next_run_at = to_timestamp($4 / 1000.0)
           FROM due WHERE schedule.id = due.id RETURNING schedule.id
         ), enqueued AS (
           INSERT INTO ${t} (id, name, key, input, status, max_attempts, run_at, timeout_ms, on_interrupt)
           SELECT $5, $6, $7, $8::jsonb, 'queued', $9, to_timestamp($10 / 1000.0), $11, $12 FROM advanced
           ON CONFLICT (name, key) WHERE key IS NOT NULL AND ${ACTIVE} DO NOTHING
           RETURNING id
         ) SELECT EXISTS (SELECT 1 FROM advanced) AS advanced`,
        [schedule.id, schedule.revision, schedule.nextRunAt, nextAt, job.id, job.name, job.key,
          json(job.input), job.maxAttempts, job.runAt, job.timeoutMs ?? null, job.onInterrupt ?? "retry"],
      );
      return (rows[0] as { advanced: boolean }).advanced;
    },
  };
}
