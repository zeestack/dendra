// A Postgres JobStore: jobs survive deploys and crashes, and any number of
// worker processes share the queue. Workers claim with FOR UPDATE SKIP LOCKED,
// so two never take the same job. Kept ZERO-DEPENDENCY: it takes a structural
// pool, so a `pg.Pool` drops in.
//
//   const store = createPgJobStore(pool);
//   await store.setup();   // CREATE TABLE IF NOT EXISTS — or copy store.schema into a migration
//
// Finished jobs stay in the table (status, result, error) until you delete them,
// e.g. `DELETE FROM dendra_jobs WHERE status IN ('succeeded','failed') AND updated_at < now() - interval '7 days'`.

import type { JobRecord, JobStore } from "./jobs.ts";

/** What `createPgJobStore` needs from a pool (a `pg.Pool` matches). */
export interface PgQueryable {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}

export interface PgJobStore extends JobStore {
  /** The CREATE statements, for a migration. */
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
  max_attempts: number;
  progress: unknown;
  result: unknown;
  error: JobRecord["error"];
  run_at: Date;
};

const toRecord = (r: Row): JobRecord => ({
  id: r.id,
  name: r.name,
  key: r.key,
  input: r.input,
  status: r.status,
  attempt: r.attempt,
  maxAttempts: r.max_attempts,
  progress: r.progress,
  result: r.result,
  error: r.error,
  runAt: r.run_at.getTime(),
});

// jsonb parameters go in as text; `undefined` becomes SQL null.
const json = (v: unknown) => (v === undefined ? null : JSON.stringify(v));

export function createPgJobStore(pool: PgQueryable, opts: { table?: string } = {}): PgJobStore {
  const table = opts.table ?? "dendra_jobs";
  if (!/^[a-z_][a-z0-9_]*$/i.test(table)) {
    throw new Error(`[dendra] pg job store: table '${table}' must be a plain identifier`);
  }
  const t = `"${table}"`;
  const ACTIVE = `status IN ('queued', 'running')`;
  const schema = [
    `CREATE TABLE IF NOT EXISTS ${t} (
      id text PRIMARY KEY,
      name text NOT NULL,
      key text,
      input jsonb,
      status text NOT NULL,
      attempt integer NOT NULL DEFAULT 0,
      max_attempts integer NOT NULL,
      progress jsonb,
      result jsonb,
      error jsonb,
      run_at timestamptz NOT NULL,
      locked_until timestamptz,
      token text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "${table}_active_key" ON ${t} (name, key) WHERE key IS NOT NULL AND ${ACTIVE}`,
    `CREATE INDEX IF NOT EXISTS "${table}_runnable" ON ${t} (name, run_at) WHERE ${ACTIVE}`,
  ];

  const one = async (text: string, values: unknown[]) => {
    const { rows } = await pool.query(text, values);
    return rows.length ? toRecord(rows[0] as Row) : null;
  };

  return {
    schema,

    async setup() {
      for (const stmt of schema) await pool.query(stmt);
    },

    async add(job) {
      // The insert loses to an active job with the same key; if that job
      // finishes before we read it, try again.
      for (let i = 0; i < 3; i++) {
        const { rows } = await pool.query(
          `INSERT INTO ${t} (id, name, key, input, status, max_attempts, run_at)
           VALUES ($1, $2, $3, $4::jsonb, 'queued', $5, to_timestamp($6 / 1000.0))
           ON CONFLICT (name, key) WHERE key IS NOT NULL AND ${ACTIVE} DO NOTHING
           RETURNING id`,
          [job.id, job.name, job.key, json(job.input), job.maxAttempts, job.runAt],
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
        `UPDATE ${t}
         SET status = 'running', attempt = attempt + 1, token = $2,
             locked_until = now() + $3 * interval '1 millisecond', updated_at = now()
         WHERE id = (
           SELECT id FROM ${t}
           WHERE name = ANY($1)
             AND ((status = 'queued' AND run_at <= now()) OR (status = 'running' AND locked_until < now()))
           ORDER BY run_at, created_at
           LIMIT 1
           FOR UPDATE SKIP LOCKED
         )
         RETURNING *`,
        [names, token, leaseMs],
      );
    },

    async extend(id, token, leaseMs) {
      const { rows } = await pool.query(
        `UPDATE ${t} SET locked_until = now() + $3 * interval '1 millisecond', updated_at = now()
         WHERE id = $1 AND token = $2 AND status = 'running' RETURNING id`,
        [id, token, leaseMs],
      );
      return rows.length > 0;
    },

    async progress(id, token, progress) {
      const { rows } = await pool.query(
        `UPDATE ${t} SET progress = $3::jsonb, updated_at = now()
         WHERE id = $1 AND token = $2 AND status = 'running' RETURNING id`,
        [id, token, json(progress)],
      );
      return rows.length > 0;
    },

    settle(id, token, outcome) {
      const owned = `WHERE id = $1 AND token = $2 AND status = 'running' RETURNING *`;
      const cleared = `token = NULL, locked_until = NULL, updated_at = now()`;
      if (outcome.status === "succeeded") {
        return one(
          `UPDATE ${t} SET status = 'succeeded', result = $3::jsonb, error = NULL, ${cleared} ${owned}`,
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
  };
}
