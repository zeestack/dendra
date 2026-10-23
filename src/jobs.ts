// Background jobs: work that outlives the request that started it (an AI call,
// an export). A procedure enqueues and returns `{ jobId }` at once; a worker in
// any process runs the job with retries and backoff; status goes out on the
// PubSub, so a client subscribes instead of polling.
//
//   const jobs = createJobs({ store: createPgJobStore(pool), pubsub, context: () => ({ db }) });
//   const summarize = jobs.define("summarize", {
//     input: s.object({ docId: s.string() }),
//     key: (input) => input.docId,              // one queued-or-running job per doc
//     run: async ({ input, ctx, job }) => { … },
//   });
//   jobs.start();                               // in every process that should run jobs
//
//   start: route.use(authed).input(s.object({ docId: s.string() })).background(summarize),
//   watch: route.input(s.object({ jobId: s.string() }))
//     .stream(({ input, signal }) => summarize.watch(input.jobId, { signal })),
//
// Jobs are named, not tied to a procedure path: a queued job must still find its
// handler after a deploy renames a route. A job's `ctx` comes from `context()`,
// never from the request — after a crash, another process has to rebuild it.
// Put what the job needs from the request (tenant, user id) in its input.
//
// The store is pluggable (`createInMemoryJobStore`, `createPgJobStore`). A worker
// holds a lease on a running job and renews it; if the process dies, the lease
// runs out and another worker retries the job.

import type { PubSub } from "./pubsub.ts";
import type { InferOutput, StandardSchemaV1 } from "./schema.ts";
import { DendraError, type ErrorCode } from "./errors.ts";

export type JobStatus = "queued" | "running" | "succeeded" | "failed";

export interface JobError {
  code: ErrorCode;
  message: string;
}

/** What a job looks like from outside: `get`, `watch`, and the PubSub events. */
export type JobSnapshot<O = unknown> = {
  id: string;
  name: string;
  /** Goes up with every change; a higher version is a newer state. */
  version: number;
  attempt: number;
  maxAttempts: number;
  progress: unknown;
} & (
  | { status: "queued" | "running"; result?: undefined; error: JobError | null }
  | { status: "succeeded"; result: O; error: null }
  | { status: "failed"; result?: undefined; error: JobError }
);

// ---------------------------------------------------------------- the store

export interface JobRecord {
  id: string;
  name: string;
  key: string | null;
  input: unknown;
  status: JobStatus;
  /** Attempts started so far (a claim adds one). */
  attempt: number;
  /** 1 when added; every visible change (claim, progress, settle) adds one. A lease renewal doesn't. */
  version: number;
  maxAttempts: number;
  progress: unknown;
  result: unknown;
  error: JobError | null;
  /** Epoch ms; a queued job isn't claimed before it. */
  runAt: number;
}

export interface NewJob {
  id: string;
  name: string;
  key: string | null;
  input: unknown;
  maxAttempts: number;
  runAt: number;
}

export type JobSettlement =
  | { status: "succeeded"; result: unknown }
  | { status: "failed"; error: JobError }
  /** Back in the queue: a retry, or (`refund`) an attempt interrupted by `stop()`. */
  | { status: "queued"; error: JobError | null; runAt: number; refund: boolean };

/**
 * Where jobs live. Every write after `claim` carries the claim's `token`, and
 * does nothing once another worker has taken the job over (its lease ran out).
 */
export interface JobStore {
  /** Insert, unless a queued or running job has the same name and key: then return that one. */
  add(job: NewJob): Promise<{ id: string; created: boolean }>;
  /** Take the next runnable job of one of `names`: queued and due, or running with an expired lease. */
  claim(names: string[], token: string, leaseMs: number): Promise<JobRecord | null>;
  /** Renew the lease. `false` when the job is no longer ours. */
  extend(id: string, token: string, leaseMs: number): Promise<boolean>;
  /** The job's new version, or `null` when the job is no longer ours. */
  progress(id: string, token: string, progress: unknown): Promise<number | null>;
  /** `null` when the job is no longer ours. */
  settle(id: string, token: string, outcome: JobSettlement): Promise<JobRecord | null>;
  get(id: string): Promise<JobRecord | null>;
}

/** A single-process store, for development and tests. Jobs don't survive a restart. */
export function createInMemoryJobStore(): JobStore {
  const jobs = new Map<string, JobRecord & { token: string | null; lockedUntil: number }>();
  const active = (j: JobRecord) => j.status === "queued" || j.status === "running";
  const view = ({ token: _t, lockedUntil: _l, ...rec }: JobRecord & { token: unknown; lockedUntil: unknown }) =>
    structuredClone(rec);
  const owned = (id: string, token: string) => {
    const j = jobs.get(id);
    return j && j.status === "running" && j.token === token ? j : undefined;
  };

  return {
    async add(job) {
      if (job.key !== null) {
        for (const j of jobs.values()) {
          if (j.name === job.name && j.key === job.key && active(j)) return { id: j.id, created: false };
        }
      }
      jobs.set(job.id, {
        ...structuredClone(job),
        status: "queued",
        attempt: 0,
        version: 1,
        progress: null,
        result: null,
        error: null,
        token: null,
        lockedUntil: 0,
      });
      return { id: job.id, created: true };
    },

    async claim(names, token, leaseMs) {
      const now = Date.now();
      let next: (JobRecord & { token: string | null; lockedUntil: number }) | undefined;
      for (const j of jobs.values()) {
        if (!names.includes(j.name)) continue;
        const due =
          (j.status === "queued" && j.runAt <= now) || (j.status === "running" && j.lockedUntil < now);
        if (due && (!next || j.runAt < next.runAt)) next = j;
      }
      if (!next) return null;
      Object.assign(next, {
        status: "running",
        attempt: next.attempt + 1,
        version: next.version + 1,
        token,
        lockedUntil: now + leaseMs,
      });
      return view(next);
    },

    async extend(id, token, leaseMs) {
      const j = owned(id, token);
      if (j) j.lockedUntil = Date.now() + leaseMs;
      return !!j;
    },

    async progress(id, token, progress) {
      const j = owned(id, token);
      if (!j) return null;
      j.progress = structuredClone(progress);
      return ++j.version;
    },

    async settle(id, token, outcome) {
      const j = owned(id, token);
      if (!j) return null;
      j.token = null;
      j.lockedUntil = 0;
      j.version++;
      if (outcome.status === "succeeded") {
        Object.assign(j, { status: "succeeded", result: structuredClone(outcome.result), error: null });
      } else if (outcome.status === "failed") {
        Object.assign(j, { status: "failed", error: outcome.error });
      } else {
        Object.assign(j, {
          status: "queued",
          error: outcome.error,
          runAt: outcome.runAt,
          attempt: outcome.refund ? j.attempt - 1 : j.attempt,
        });
      }
      return view(j);
    },

    async get(id) {
      const j = jobs.get(id);
      return j ? view(j) : null;
    },
  };
}

// ---------------------------------------------------------------- the runner

export interface JobHandle {
  id: string;
  /** 1 on the first run, 2 on the first retry, … */
  attempt: number;
  /** Aborts when the worker stops or loses the job's lease. Pass it to long work. */
  signal: AbortSignal;
  /** Store and publish progress (anything JSON) for watchers. */
  progress(progress: unknown): Promise<void>;
}

export interface JobOptions<Ctx, I, O> {
  /** Validated when the job is enqueued. */
  input?: StandardSchemaV1<unknown, I>;
  run: (o: { input: I; ctx: Ctx; job: JobHandle }) => O | Promise<O>;
  /** Retries after the first attempt fails. Default 2. */
  retries?: number;
  /** Delay before retry n: `initialMs · 2^(n-1)`, capped at `maxMs`. Default 1 s → 60 s. */
  backoff?: { initialMs?: number; maxMs?: number };
  /** Jobs of this name running at once in each process. Default 5. */
  concurrency?: number;
  /** At most one queued-or-running job per key: enqueueing again returns that job's id. */
  key?: (input: I) => string | null | undefined;
}

export interface Job<I = unknown, O = unknown> {
  readonly name: string;
  /** Validate and queue. Returns at once; the job runs on a worker. */
  enqueue(input: I, opts?: { delayMs?: number }): Promise<{ jobId: string }>;
  get(id: string): Promise<JobSnapshot<O> | null>;
  /** The job's current state, then every change, ending when it succeeds or fails. */
  watch(id: string, opts?: { signal?: AbortSignal }): AsyncIterable<JobSnapshot<O>>;
}

export interface JobsOptions<Ctx> {
  store: JobStore;
  /** Status events (and cross-process wake-ups) go out here. */
  pubsub: PubSub;
  /** The `ctx` a job runs with: your db, pubsub, clients. Never the request's. */
  context: () => Ctx | Promise<Ctx>;
  /** How often an idle worker checks the store. Default 1000 ms. */
  pollMs?: number;
  /** How long a claim lasts without renewal (renewed every third of it). Default 30 s. */
  leaseMs?: number;
  /** Failed attempts and store errors. Default: `console.error`. */
  onError?: (err: unknown, job?: { id: string; name: string; attempt: number }) => void;
}

export interface Jobs<Ctx> {
  define<S extends StandardSchemaV1, O>(
    name: string,
    opts: JobOptions<Ctx, InferOutput<S>, O> & { input: S },
  ): Job<InferOutput<S>, Awaited<O>>;
  define<I, O>(name: string, opts: JobOptions<Ctx, I, O>): Job<I, Awaited<O>>;
  get(id: string): Promise<JobSnapshot | null>;
  watch(id: string, opts?: { signal?: AbortSignal }): AsyncIterable<JobSnapshot>;
  /** Start running jobs in this process. Without it, this process only enqueues. */
  start(): void;
  /** Stop claiming, abort running jobs and put them back in the queue (no attempt used). */
  stop(): Promise<void>;
}

const WAKE_TOPIC = "dendra:jobs";
const statusTopic = (id: string) => `dendra:job:${id}`;
const isDone = (s: JobStatus) => s === "succeeded" || s === "failed";

function snapshot<O>(r: JobRecord): JobSnapshot<O> {
  return {
    id: r.id,
    name: r.name,
    version: r.version,
    status: r.status,
    attempt: r.attempt,
    maxAttempts: r.maxAttempts,
    progress: r.progress,
    result: r.status === "succeeded" ? r.result : undefined,
    error: r.error,
  } as JobSnapshot<O>;
}

// Same shape the HTTP handler sends for a thrown error.
function toJobError(e: unknown): JobError {
  if (e instanceof DendraError) return { code: e.code, message: e.message };
  return { code: "INTERNAL", message: e instanceof Error ? e.message : "Internal error" };
}

type Def<Ctx> = {
  name: string;
  run: JobOptions<Ctx, unknown, unknown>["run"];
  concurrency: number;
  initialMs: number;
  maxMs: number;
};

export function createJobs<Ctx>(opts: JobsOptions<Ctx>): Jobs<Ctx> {
  const { store, pubsub } = opts;
  const pollMs = opts.pollMs ?? 1000;
  const leaseMs = opts.leaseMs ?? 30_000;
  const report =
    opts.onError ??
    ((e: unknown, job?: { id: string; name: string }) =>
      console.error(job ? `[dendra] job '${job.name}' (${job.id}) failed:` : "[dendra] jobs:", e));

  const defs = new Map<string, Def<Ctx>>();
  const active = new Map<string, number>();
  const running = new Set<{ ac: AbortController; done: Promise<void> }>();
  let started = false;
  let stopping = false;
  let loop: Promise<void> | null = null;
  let wake: (() => void) | null = null;
  const nudge = () => {
    wake?.();
    wake = null;
  };
  let wakeSub: AbortController | null = null;

  const publish = (r: JobRecord) => {
    try {
      pubsub.publish(statusTopic(r.id), snapshot(r));
    } catch (e) {
      report(e);
    }
  };

  async function runJob(def: Def<Ctx>, rec: JobRecord, token: string, ac: AbortController): Promise<void> {
    const meta = { id: rec.id, name: rec.name, attempt: rec.attempt };
    const heartbeat = setInterval(() => {
      store.extend(rec.id, token, leaseMs).then(
        (ok) => ok || ac.abort(new Error("lease lost")),
        (e) => report(e, meta),
      );
    }, leaseMs / 3);

    let outcome: JobSettlement;
    if (rec.attempt > rec.maxAttempts) {
      // Claimed again after its lease ran out on the last attempt (a crash).
      outcome = {
        status: "failed",
        error: { code: "INTERNAL", message: "Job was interrupted on its last attempt" },
      };
    } else {
      publish(rec);
      try {
        const result = await def.run({
          input: rec.input,
          ctx: await opts.context(),
          job: {
            id: rec.id,
            attempt: rec.attempt,
            signal: ac.signal,
            progress: async (progress) => {
              const version = await store.progress(rec.id, token, progress);
              if (version !== null) publish({ ...rec, progress, version });
            },
          },
        });
        outcome = { status: "succeeded", result: result ?? null };
      } catch (e) {
        const error = toJobError(e);
        if (stopping && ac.signal.aborted) {
          outcome = { status: "queued", error: rec.error, runAt: Date.now(), refund: true };
        } else {
          report(e, meta);
          outcome =
            rec.attempt < rec.maxAttempts
              ? {
                  status: "queued",
                  error,
                  runAt: Date.now() + Math.min(def.initialMs * 2 ** (rec.attempt - 1), def.maxMs),
                  refund: false,
                }
              : { status: "failed", error };
        }
      }
    }
    clearInterval(heartbeat);
    try {
      const settled = await store.settle(rec.id, token, outcome);
      if (settled) publish(settled);
    } catch (e) {
      report(e, meta);
    }
  }

  async function work(): Promise<void> {
    while (!stopping) {
      const free = [...defs.values()].filter((d) => (active.get(d.name) ?? 0) < d.concurrency);
      let claimed: { def: Def<Ctx>; rec: JobRecord; token: string } | null = null;
      if (free.length) {
        const token = crypto.randomUUID();
        try {
          const rec = await store.claim(free.map((d) => d.name), token, leaseMs);
          if (rec) claimed = { def: defs.get(rec.name)!, rec, token };
        } catch (e) {
          report(e);
        }
      }
      if (!claimed) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, pollMs);
          wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        continue;
      }
      const { def, rec, token } = claimed;
      active.set(def.name, (active.get(def.name) ?? 0) + 1);
      const ac = new AbortController();
      const entry = { ac, done: Promise.resolve() };
      entry.done = runJob(def, rec, token, ac).finally(() => {
        active.set(def.name, active.get(def.name)! - 1);
        running.delete(entry);
        nudge(); // a slot is free
      });
      running.add(entry);
    }
  }

  async function* watch(id: string, wopts: { signal?: AbortSignal } = {}): AsyncIterable<JobSnapshot> {
    const ac = new AbortController();
    const stop = () => ac.abort();
    if (wopts.signal?.aborted) return;
    wopts.signal?.addEventListener("abort", stop, { once: true });
    // Subscribe before reading the store so no change falls in between. A change
    // made while we read arrives both in the record and as an event; the version
    // drops the event, and any older one, so each state shows once and in order.
    const events = pubsub.subscribe(statusTopic(id), { signal: ac.signal })[Symbol.asyncIterator]();
    try {
      const rec = await store.get(id);
      if (!rec) throw new DendraError("NOT_FOUND", `No job '${id}'`);
      yield snapshot(rec);
      if (isDone(rec.status)) return;
      let seen = rec.version;
      for (;;) {
        const next = await events.next();
        if (next.done) return;
        const snap = next.value as JobSnapshot;
        if (snap.version <= seen) continue;
        seen = snap.version;
        yield snap;
        if (isDone(snap.status)) return;
      }
    } finally {
      wopts.signal?.removeEventListener("abort", stop);
      ac.abort();
      await events.return?.();
    }
  }

  const get = async (id: string) => {
    const rec = await store.get(id);
    return rec ? snapshot(rec) : null;
  };

  return {
    define(name: string, o: JobOptions<Ctx, unknown, unknown>) {
      if (defs.has(name)) throw new Error(`[dendra] job '${name}' is already defined`);
      const retries = o.retries ?? 2;
      defs.set(name, {
        name,
        run: o.run,
        concurrency: o.concurrency ?? 5,
        initialMs: o.backoff?.initialMs ?? 1000,
        maxMs: o.backoff?.maxMs ?? 60_000,
      });
      return {
        name,
        async enqueue(raw: unknown, eopts: { delayMs?: number } = {}) {
          let input = raw;
          if (o.input) {
            const res = await o.input["~standard"].validate(raw);
            if (res.issues !== undefined) {
              throw new DendraError("BAD_REQUEST", `Invalid input for job '${name}'`, 400, res.issues);
            }
            input = res.value;
          }
          const { id, created } = await store.add({
            id: crypto.randomUUID(),
            name,
            key: o.key?.(input) ?? null,
            input,
            maxAttempts: retries + 1,
            runAt: Date.now() + (eopts.delayMs ?? 0),
          });
          if (created) {
            nudge();
            pubsub.publish(WAKE_TOPIC, name);
          }
          return { jobId: id };
        },
        get,
        watch,
      };
    },
    get,
    watch,

    start() {
      if (started) return;
      started = true;
      wakeSub = new AbortController();
      const sub = pubsub.subscribe(WAKE_TOPIC, { signal: wakeSub.signal });
      void (async () => {
        for await (const _ of sub) nudge();
      })().catch((e) => report(e));
      loop = work();
    },

    async stop() {
      if (!started) return;
      stopping = true;
      wakeSub?.abort();
      nudge();
      await loop;
      for (const r of running) r.ac.abort(new Error("jobs stopping"));
      await Promise.all([...running].map((r) => r.done));
    },
  } as Jobs<Ctx>;
}
