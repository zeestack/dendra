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
import { enqueueDueSchedules, nextOccurrence, validateCalendar, type JobCalendar, type JobScheduleStore, type ScheduleRecord } from "./job-schedules.ts";
import type { InferOutput, StandardSchemaV1 } from "./schema.ts";
import { DendraError, publicError, type ErrorCode } from "./errors.ts";

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
  /** Maximum execution time for each attempt; absent means no deadline. */
  timeoutMs?: number;
  /** Fail instead of replaying work interrupted by shutdown, a deadline, or a lost worker. */
  onInterrupt?: "retry" | "fail";
  /** Epoch ms, set atomically on claim and cleared on settlement. */
  deadlineAt?: number | null;
  /** Claim-only flag: this attempt reclaimed a running job. */
  interrupted?: boolean;
}

export interface NewJob {
  id: string;
  name: string;
  key: string | null;
  input: unknown;
  maxAttempts: number;
  runAt: number;
  timeoutMs?: number;
  onInterrupt?: "retry" | "fail";
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
export interface JobStore extends Partial<JobScheduleStore> {
  /** Explicit support prevents silently ignoring policies in third-party stores. */
  capabilities?: { executionPolicies?: boolean; schedules?: boolean };
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
export function createInMemoryJobStore(): JobStore & JobScheduleStore {
  const jobs = new Map<string, JobRecord & { token: string | null; lockedUntil: number }>();
  const schedules = new Map<string, ScheduleRecord>();
  let scheduleRevision = 0;
  const active = (j: JobRecord) => j.status === "queued" || j.status === "running";
  const view = ({ token: _t, lockedUntil: _l, ...rec }: JobRecord & { token: unknown; lockedUntil: unknown }) =>
    structuredClone(rec);
  const owned = (id: string, token: string) => {
    const j = jobs.get(id);
    return j && j.status === "running" && j.token === token ? j : undefined;
  };

  const add = (job: NewJob): { id: string; created: boolean } => {
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
      deadlineAt: null,
    });
    return { id: job.id, created: true };
  };
  const store: JobStore & JobScheduleStore = {
    capabilities: { executionPolicies: true, schedules: true },
    async add(job) { return add(job); },

    async claim(names, token, leaseMs) {
      const now = Date.now();
      let next: (JobRecord & { token: string | null; lockedUntil: number }) | undefined;
      for (const j of jobs.values()) {
        if (!names.includes(j.name)) continue;
        const due =
          (j.status === "queued" && j.runAt <= now) ||
          (j.status === "running" && (j.lockedUntil < now || (j.deadlineAt != null && j.deadlineAt <= now)));
        if (due && (!next || j.runAt < next.runAt)) next = j;
      }
      if (!next) return null;
      const interrupted = next.status === "running";
      Object.assign(next, {
        status: "running",
        attempt: next.attempt + 1,
        version: next.version + 1,
        token,
        lockedUntil: now + leaseMs,
        deadlineAt: next.timeoutMs === undefined ? null : now + next.timeoutMs,
      });
      return { ...view(next), interrupted };
    },

    async extend(id, token, leaseMs) {
      const j = owned(id, token);
      if (!j || (j.deadlineAt != null && j.deadlineAt <= Date.now())) return false;
      j.lockedUntil = Date.now() + leaseMs;
      return true;
    },

    async progress(id, token, progress) {
      const j = owned(id, token);
      if (!j || (j.deadlineAt != null && j.deadlineAt <= Date.now())) return null;
      j.progress = structuredClone(progress);
      return ++j.version;
    },

    async settle(id, token, outcome) {
      const j = owned(id, token);
      if (!j || (outcome.status === "succeeded" && j.deadlineAt != null && j.deadlineAt <= Date.now())) return null;
      j.token = null;
      j.lockedUntil = 0;
      j.deadlineAt = null;
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

    async putSchedule(next) {
      const previous = schedules.get(next.id);
      // Stable JSON ignores insertion order, matching Postgres jsonb equality.
      const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable)
        : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stable(v)]))
        : value;
      const config = ({ nextRunAt: _next, revision: _revision, ...rest }: ScheduleRecord) =>
        JSON.stringify(stable(JSON.parse(JSON.stringify({ ...rest, onInterrupt: rest.onInterrupt ?? "retry" }))));
      if (previous && config(previous) === config({ ...next, revision: 0 })) return structuredClone(previous);
      const saved = structuredClone({ ...next, revision: ++scheduleRevision });
      schedules.set(next.id, saved);
      return structuredClone(saved);
    },
    async removeSchedule(id) {
      return schedules.delete(id);
    },
    async dueSchedules(names, now, limit = 100) {
      return [...schedules.values()].filter((s) => names.includes(s.name) && s.nextRunAt <= now)
        .sort((a, b) => a.nextRunAt - b.nextRunAt || a.id.localeCompare(b.id)).slice(0, limit).map((s) => structuredClone(s));
    },
    async advanceSchedule(record, nextRunAt, job) {
      if (!Number.isFinite(nextRunAt) || nextRunAt <= record.nextRunAt) throw new Error("[dendra] schedule cursor must advance");
      const current = schedules.get(record.id);
      if (!current || current.revision !== record.revision || current.nextRunAt !== record.nextRunAt) return false;
      // add mutates synchronously; both writes occur before yielding to another worker.
      add(job);
      current.nextRunAt = nextRunAt;
      return true;
    },
  };
  return store;
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
  /** Per-attempt execution deadline. Requires a store with executionPolicies support. */
  timeoutMs?: number;
  /** Default "retry" preserves 0.9 behavior. Use "fail" for non-idempotent/paid work. */
  onInterrupt?: "retry" | "fail";
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
  /** Register or update a durable daily/weekly UTC schedule. */
  schedule(id: string, input: I, calendar: JobCalendar): Promise<void>;
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

export interface JobStopOptions {
  /** Time to let existing work finish before aborting it. Default 0. */
  graceMs?: number;
  /** Total budget, including grace and store settlement. */
  timeoutMs: number;
}

export interface JobStopResult {
  drained: boolean;
  /** Jobs still executing/unsettled, plus an unresolved worker-loop operation. */
  pending: number;
  errors?: JobError[];
}

export interface Jobs<Ctx> {
  define<S extends StandardSchemaV1, O>(
    name: string,
    opts: JobOptions<Ctx, InferOutput<S>, O> & { input: S },
  ): Job<InferOutput<S>, Awaited<O>>;
  define<I, O>(name: string, opts: JobOptions<Ctx, I, O>): Job<I, Awaited<O>>;
  get(id: string): Promise<JobSnapshot | null>;
  watch(id: string, opts?: { signal?: AbortSignal }): AsyncIterable<JobSnapshot>;
  unschedule(id: string): Promise<void>;
  /** Start running jobs in this process. Without it, this process only enqueues. */
  start(): void;
  /**
   * Stop claiming and abort running work. Interrupted jobs follow their persisted policy:
   * retry jobs are requeued without using an attempt; fail jobs are never replayed.
   * With no options, allow 30 seconds for drainage and reject if work remains.
   */
  stop(): Promise<void>;
  /** Allow a grace period, then abort; return unresolved work within the total budget. */
  stop(opts: JobStopOptions): Promise<JobStopResult>;
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

// Same shape the HTTP handler sends for a thrown error: snapshots reach
// browsers, so an unexpected error's message stays out (`onError` has it).
function toJobError(e: unknown): JobError {
  const { code, message } = publicError(e);
  return { code, message };
}

// For `stop()`'s result, which goes to the operator: the full message.
function operatorError(e: unknown): JobError {
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
  const reportError =
    opts.onError ??
    ((e: unknown, job?: { id: string; name: string }) =>
      console.error(job ? `[dendra] job '${job.name}' (${job.id}) failed:` : "[dendra] jobs:", e));

  const report: NonNullable<JobsOptions<Ctx>["onError"]> = (error, meta) => {
    try { reportError(error, meta); } catch { /* A logging hook must not stop the worker. */ }
  };
  const scheduleStore = (): JobScheduleStore => {
    if (!store.capabilities?.schedules || !store.putSchedule || !store.removeSchedule || !store.dueSchedules || !store.advanceSchedule)
      throw new Error("[dendra] this job store does not support schedules");
    return store as JobScheduleStore;
  };
  const defs = new Map<string, Def<Ctx>>();
  const active = new Map<string, number>();
  type Running = { id: string; done: Promise<void>; interrupt: (reason: "shutdown" | "timeout" | "lease") => void };
  const running = new Set<Running>();
  const unsettled = new Map<string, JobError>();
  let loopPending = false;
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

  function runJob(def: Def<Ctx>, rec: JobRecord, token: string): Running {
    const meta = { id: rec.id, name: rec.name, attempt: rec.attempt };
    const ac = new AbortController();
    let selected = false;
    let settlement: Promise<void> = Promise.resolve();
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const clearTimers = () => { clearInterval(heartbeat); clearTimeout(deadlineTimer); };
    const choose = (outcome: JobSettlement) => {
      if (selected) return;
      selected = true;
      clearTimers();
      settlement = Promise.resolve().then(async () => {
        let settled = await store.settle(rec.id, token, outcome);
        // Storage may execute a success write after the deadline even though the handler
        // returned in time. Stores reject that write; resolve our still-owned row instead
        // of reporting drainage while it is running. Another owner's token remains fenced.
        if (!settled && outcome.status === "succeeded" && rec.deadlineAt != null) {
          const error: JobError = { code: "INTERNAL", message: "Job execution deadline exceeded" };
          settled = await store.settle(rec.id, token, rec.onInterrupt === "fail" ? { status: "failed", error } : failure(error));
        }
        return settled;
      }).then((settled) => {
        if (settled) {
          unsettled.delete(rec.id);
          publish(settled);
        }
      }, (error) => {
        unsettled.set(rec.id, operatorError(error));
        report(error, meta);
      });
    };
    const failure = (error: JobError): JobSettlement => rec.attempt < rec.maxAttempts
      ? { status: "queued", error, runAt: Date.now() + Math.min(def.initialMs * 2 ** (rec.attempt - 1), def.maxMs), refund: false }
      : { status: "failed", error };
    const interrupt: Running["interrupt"] = (reason) => {
      if (selected) return;
      const error = { code: "INTERNAL" as const, message: reason === "timeout" ? "Job execution deadline exceeded"
        : reason === "lease" ? "Job lease was lost" : "Job interrupted by worker shutdown" };
      if (reason === "lease") {
        // Another token may own the row. Only that owner decides its durable outcome.
        selected = true;
        clearTimers();
      } else if (rec.onInterrupt === "fail") {
        choose({ status: "failed", error });
      } else if (reason === "shutdown") {
        choose({ status: "queued", error: rec.error, runAt: Date.now(), refund: true });
      } else {
        choose(failure(error));
      }
      ac.abort(new Error(error.message));
      if (reason !== "shutdown") report(new Error(error.message), meta);
    };
    const checkDeadline = () => {
      if (!selected && rec.deadlineAt != null && rec.deadlineAt <= Date.now()) interrupt("timeout");
    };
    const entry: Running = { id: rec.id, done: Promise.resolve(), interrupt };
    active.set(def.name, (active.get(def.name) ?? 0) + 1);
    running.add(entry);
    heartbeat = setInterval(() => {
      void Promise.resolve().then(() => store.extend(rec.id, token, leaseMs)).then(
        (ok) => { if (!ok && !selected) interrupt(rec.deadlineAt != null && rec.deadlineAt <= Date.now() ? "timeout" : "lease"); },
        (error) => report(error, meta),
      );
    }, leaseMs / 3);
    if (rec.deadlineAt != null) {
      // Rearm long deadlines: Node clamps timers above 2^31-1 to one millisecond.
      const arm = () => {
        const remaining = rec.deadlineAt! - Date.now();
        if (remaining <= 0) interrupt("timeout");
        else deadlineTimer = setTimeout(arm, Math.min(remaining, 2_147_483_647));
      };
      arm();
    }
    entry.done = (async () => {
      try {
        if (stopping) { interrupt("shutdown"); return; }
        if (rec.interrupted && rec.onInterrupt === "fail") {
          choose({ status: "failed", error: { code: "INTERNAL", message: "Job was interrupted; replay is disabled" } });
          return;
        }
        if (rec.attempt > rec.maxAttempts) {
          choose({ status: "failed", error: { code: "INTERNAL", message: "Job was interrupted on its last attempt" } });
          return;
        }
        if (selected) return;
        publish(rec);
        const ctx = await opts.context();
        checkDeadline();
        // A context factory can outlive shutdown or the deadline too.
        if (selected || ac.signal.aborted) return;
        const result = await def.run({ input: rec.input, ctx, job: {
          id: rec.id, attempt: rec.attempt, signal: ac.signal,
          progress: async (progress) => {
            checkDeadline();
            if (selected || ac.signal.aborted) return;
            const version = await store.progress(rec.id, token, progress);
            checkDeadline();
            if (!selected && version !== null) publish({ ...rec, progress, version });
          },
        } });
        checkDeadline();
        choose({ status: "succeeded", result: result ?? null });
      } catch (error) {
        checkDeadline();
        if (!selected) { report(error, meta); choose(failure(toJobError(error))); }
      } finally {
        // Do not release capacity when merely aborting: JavaScript or a provider can ignore the signal.
        clearTimers();
        await settlement;
      }
    })().finally(() => {
      active.set(def.name, active.get(def.name)! - 1);
      running.delete(entry);
      nudge();
    });
    return entry;
  }

  async function work(): Promise<void> {
    try {
      while (!stopping) {
        if (store.capabilities?.schedules) {
          try { await enqueueDueSchedules(scheduleStore(), [...defs.keys()]); }
          catch (error) { report(error); }
        }
        if (stopping) break;
        const free = [...defs.values()].filter((d) => (active.get(d.name) ?? 0) < d.concurrency);
        let claimed: { def: Def<Ctx>; rec: JobRecord; token: string } | null = null;
        if (free.length) {
          const token = crypto.randomUUID();
          try {
            const rec = await store.claim(free.map((d) => d.name), token, leaseMs);
            if (rec) claimed = { def: defs.get(rec.name)!, rec, token };
          } catch (error) { report(error); }
        }
        if (claimed) {
          // If claim completed after stop's budget, settle it without ever running user code.
          runJob(claimed.def, claimed.rec, claimed.token);
          continue;
        }
        if (stopping) break;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, pollMs);
          wake = () => { clearTimeout(timer); resolve(); };
        });
      }
    } finally { loopPending = false; }
  }

  const pending = () => new Set([...running].map((r) => r.id).concat([...unsettled.keys()])).size + (loopPending ? 1 : 0);
  async function waitForActivity(until: number): Promise<void> {
    while (loopPending || running.size) {
      const ms = until - Date.now();
      if (ms <= 0) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const completed = await Promise.race([
        Promise.all([loop, ...[...running].map((r) => r.done)]).then(() => true),
        new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), Math.min(ms, 2_147_483_647)); }),
      ]);
      clearTimeout(timer);
      if (!completed) return;
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
      if (o.timeoutMs !== undefined && (!Number.isSafeInteger(o.timeoutMs) || o.timeoutMs <= 0))
        throw new Error("[dendra] timeoutMs must be a positive safe integer");
      if (o.onInterrupt !== undefined && o.onInterrupt !== "retry" && o.onInterrupt !== "fail")
        throw new Error("[dendra] onInterrupt must be 'retry' or 'fail'");
      if ((o.timeoutMs !== undefined || o.onInterrupt !== undefined) && !store.capabilities?.executionPolicies)
        throw new Error("[dendra] this job store does not support execution policies");
      const retries = o.retries ?? 2;
      defs.set(name, {
        name,
        run: o.run,
        concurrency: o.concurrency ?? 5,
        initialMs: o.backoff?.initialMs ?? 1000,
        maxMs: o.backoff?.maxMs ?? 60_000,
      });
      const validateInput = async (raw: unknown) => {
        if (!o.input) return raw;
        const res = await o.input["~standard"].validate(raw);
        if (res.issues !== undefined) throw new DendraError("BAD_REQUEST", `Invalid input for job '${name}'`, 400, res.issues);
        return res.value;
      };
      return {
        name,
        async enqueue(raw: unknown, eopts: { delayMs?: number } = {}) {
          const input = await validateInput(raw);
          const { id, created } = await store.add({
            id: crypto.randomUUID(),
            name,
            key: o.key?.(input) ?? null,
            input,
            maxAttempts: retries + 1,
            ...(o.timeoutMs === undefined ? {} : { timeoutMs: o.timeoutMs }),
            ...(o.onInterrupt === undefined ? {} : { onInterrupt: o.onInterrupt }),
            runAt: Date.now() + (eopts.delayMs ?? 0),
          });
          if (created) {
            nudge();
            pubsub.publish(WAKE_TOPIC, name);
          }
          return { jobId: id };
        },
        async schedule(id: string, raw: unknown, calendar: JobCalendar) {
          const scheduling = scheduleStore();
          if (!id.trim()) throw new Error("[dendra] schedule id must not be empty");
          validateCalendar(calendar);
          const input = await validateInput(raw);
          await scheduling.putSchedule({ id, name, input, key: o.key?.(input) ?? null, maxAttempts: retries + 1,
            ...(o.timeoutMs === undefined ? {} : { timeoutMs: o.timeoutMs }),
            ...(o.onInterrupt === undefined ? {} : { onInterrupt: o.onInterrupt }),
            calendar, nextRunAt: nextOccurrence(calendar, Date.now()),
          });
          nudge();
        },
        get,
        watch,
      };
    },
    async unschedule(id: string) { await scheduleStore().removeSchedule(id); },
    get,
    watch,

    start() {
      if (started || stopping) return;
      started = true;
      wakeSub = new AbortController();
      const sub = pubsub.subscribe(WAKE_TOPIC, { signal: wakeSub.signal });
      void (async () => {
        for await (const _ of sub) nudge();
      })().catch((e) => report(e));
      loopPending = true;
      loop = work();
    },

    async stop(options?: JobStopOptions) {
      const graceMs = options?.graceMs ?? 0;
      const timeoutMs = options?.timeoutMs ?? 30_000;
      if (!Number.isSafeInteger(graceMs) || graceMs < 0 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || graceMs > timeoutMs)
        throw new Error("[dendra] stop requires 0 <= graceMs <= timeoutMs (safe integer milliseconds)");
      if (!started) return options ? { drained: true, pending: 0 } : undefined;
      const until = Date.now() + timeoutMs;
      stopping = true;
      wakeSub?.abort();
      nudge();
      if (graceMs) await waitForActivity(Math.min(until, Date.now() + graceMs));
      for (const entry of running) entry.interrupt("shutdown");
      await waitForActivity(until);
      const count = pending();
      if (options) return { drained: count === 0, pending: count, ...(unsettled.size ? { errors: [...unsettled.values()] } : {}) };
      if (count) throw new Error(`[dendra] jobs did not drain before shutdown (${count} pending)`);
    },
  } as Jobs<Ctx>;
}
