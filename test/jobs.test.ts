import { describe, it, expect, afterAll, afterEach } from "vitest";
import {
  createCaller,
  createInMemoryJobStore,
  createInMemoryPubSub,
  createJobs,
  createPgJobStore,
  DendraError,
  initDendra,
  s,
  type JobSnapshot,
  type JobStore,
  type Jobs,
} from "../src/index.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(check: () => boolean | Promise<boolean>, ms = 2000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out");
    await sleep(5);
  }
}

async function collect<T>(it: AsyncIterable<T>) {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

const started: Jobs<unknown>[] = [];
afterEach(async () => {
  await Promise.all(started.splice(0).map((j) => j.stop({ timeoutMs: 100 })));
});

function setup(store: JobStore = createInMemoryJobStore(), ctx: unknown = { db: "worker-db" }) {
  const pubsub = createInMemoryPubSub();
  const errors: unknown[] = [];
  const jobs = createJobs({
    store,
    pubsub,
    context: () => ctx as { db: string },
    pollMs: 10,
    leaseMs: 300,
    onError: (e) => errors.push(e),
  });
  started.push(jobs as Jobs<unknown>);
  return { jobs, store, pubsub, errors };
}

describe("createJobs", () => {
  it("watch shows each change once, in order, when the job moves while watch reads the store", async () => {
    // A store whose first read is slow, so the job is claimed (and that change
    // published) between watch subscribing and watch reading the store.
    const inner = createInMemoryJobStore();
    let releaseRead!: () => void;
    const readGate = new Promise<void>((r) => (releaseRead = r));
    let slowReads = 1;
    const store: JobStore = {
      ...inner,
      async get(id) {
        if (slowReads-- > 0) await readGate;
        return inner.get(id);
      },
    };
    const { jobs } = setup(store);
    let finish!: () => void;
    const job = jobs.define("gated", {
      run: () => new Promise<void>((r) => (finish = r)),
    });
    const { jobId } = await job.enqueue(undefined);
    const seen = collect(job.watch(jobId));
    jobs.start();
    await until(async () => (await inner.get(jobId))?.status === "running");
    await sleep(20); // the "running" event is now waiting in watch's subscription
    releaseRead();
    await sleep(20);
    finish();
    const snaps = await seen;
    expect(snaps.map((x) => x.status)).toEqual(["running", "succeeded"]);
    const versions = snaps.map((x) => x.version);
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
    expect(new Set(versions).size).toBe(versions.length);
  });

  it("runs a job with the worker ctx and streams its status", async () => {
    const { jobs } = setup();
    const add = jobs.define("add", {
      input: s.object({ a: s.number(), b: s.number() }),
      run: ({ input, ctx }) => ({ sum: input.a + input.b, db: ctx.db }),
    });

    const { jobId } = await add.enqueue({ a: 2, b: 3 });
    const seen = collect(add.watch(jobId));
    jobs.start();

    const statuses = await seen;
    expect(statuses.map((s) => s.status)).toEqual(["queued", "running", "succeeded"]);
    expect(statuses.at(-1)).toMatchObject({ id: jobId, name: "add", attempt: 1, result: { sum: 5, db: "worker-db" } });
    expect(await add.get(jobId)).toMatchObject({ status: "succeeded", result: { sum: 5, db: "worker-db" } });
  });

  it("retries with backoff, then fails with the last error", async () => {
    const { jobs, errors } = setup();
    let calls = 0;
    const flaky = jobs.define("flaky", {
      retries: 2,
      backoff: { initialMs: 20 },
      run: () => {
        calls++;
        throw new DendraError("CONFLICT", `attempt ${calls}`);
      },
    });
    jobs.start();
    const { jobId } = await flaky.enqueue(null);
    const seen = await collect(flaky.watch(jobId));

    expect(calls).toBe(3);
    expect(seen.at(-1)).toMatchObject({
      status: "failed",
      attempt: 3,
      maxAttempts: 3,
      error: { code: "CONFLICT", message: "attempt 3" },
    });
    // While waiting for a retry, the last error is visible.
    expect(seen.some((s) => s.status === "queued" && s.error?.message === "attempt 1")).toBe(true);
    expect(errors).toHaveLength(3);
  });

  it("succeeds on a retry", async () => {
    const { jobs } = setup();
    let calls = 0;
    const job = jobs.define("second-time", {
      backoff: { initialMs: 1 },
      run: ({ job }) => {
        if (++calls === 1) throw new Error("boom");
        return job.attempt;
      },
    });
    jobs.start();
    const { jobId } = await job.enqueue(undefined);
    const last = (await collect(job.watch(jobId))).at(-1)!;
    expect(last).toMatchObject({ status: "succeeded", result: 2, error: null });
  });

  it("keeps one queued-or-running job per key", async () => {
    const { jobs } = setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const job = jobs.define("per-doc", {
      input: s.object({ docId: s.string() }),
      key: (input) => input.docId,
      run: () => gate,
    });

    const a = await job.enqueue({ docId: "d1" });
    const b = await job.enqueue({ docId: "d1" });
    const c = await job.enqueue({ docId: "d2" });
    expect(b.jobId).toBe(a.jobId);
    expect(c.jobId).not.toBe(a.jobId);

    jobs.start();
    await until(async () => (await job.get(a.jobId))?.status === "running");
    expect((await job.enqueue({ docId: "d1" })).jobId).toBe(a.jobId);

    release();
    await until(async () => (await job.get(a.jobId))?.status === "succeeded");
    expect((await job.enqueue({ docId: "d1" })).jobId).not.toBe(a.jobId);
  });

  it("caps how many jobs of a name run at once", async () => {
    const { jobs } = setup();
    let now = 0;
    let peak = 0;
    const job = jobs.define("capped", {
      concurrency: 2,
      run: async () => {
        peak = Math.max(peak, ++now);
        await sleep(20);
        now--;
      },
    });
    const ids = await Promise.all([1, 2, 3, 4, 5].map(() => job.enqueue(null)));
    jobs.start();
    await until(async () => (await Promise.all(ids.map(({ jobId }) => job.get(jobId)))).every((j) => j?.status === "succeeded"));
    expect(peak).toBe(2);
  });

  it("publishes progress to watchers", async () => {
    const { jobs } = setup();
    const job = jobs.define("progress", {
      run: async ({ job }) => {
        await job.progress({ pct: 50 });
        return "done";
      },
    });
    const { jobId } = await job.enqueue(null);
    const seen = collect(job.watch(jobId));
    jobs.start();
    const all = await seen;
    expect(all.find((s) => s.status === "running" && s.progress)?.progress).toEqual({ pct: 50 });
    expect(all.at(-1)?.progress).toEqual({ pct: 50 });
  });

  it("validates input on enqueue and refuses unknown ids and duplicate names", async () => {
    const { jobs } = setup();
    const job = jobs.define("typed", { input: s.object({ n: s.integer() }), run: () => {} });
    await expect(job.enqueue({ n: "x" } as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(collect(jobs.watch("nope"))).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(() => jobs.define("typed", { run: () => {} })).toThrow(/already defined/);
  });

  it("stop() puts running jobs back without using an attempt; another worker finishes them", async () => {
    const store = createInMemoryJobStore();
    const first = setup(store);
    const job = first.jobs.define("long", {
      run: ({ job }) =>
        new Promise((resolve, reject) => {
          job.signal.addEventListener("abort", () => reject(job.signal.reason));
        }),
    });
    first.jobs.start();
    const { jobId } = await job.enqueue(null);
    await until(async () => (await job.get(jobId))?.status === "running");
    await first.jobs.stop();
    expect(await job.get(jobId)).toMatchObject({ status: "queued", attempt: 0 });
    expect(first.errors).toHaveLength(0);

    // The next deploy.
    const second = setup(store);
    second.jobs.define("long", { run: ({ job }) => `finished on attempt ${job.attempt}` });
    second.jobs.start();
    await until(async () => (await second.jobs.get(jobId))?.status === "succeeded");
    expect(await second.jobs.get(jobId)).toMatchObject({ result: "finished on attempt 1" });
  });

  it("retries a job whose worker died once its lease runs out", async () => {
    const store = createInMemoryJobStore();
    const { jobs } = setup(store);
    const job = jobs.define("orphan", { run: ({ job }) => job.attempt });
    const { jobId } = await job.enqueue(null);

    // A worker claims it with a short lease, then the process dies.
    expect(await store.claim(["orphan"], "dead-worker", 30)).toMatchObject({ id: jobId, attempt: 1 });
    jobs.start();
    await until(async () => (await job.get(jobId))?.status === "succeeded");
    expect(await job.get(jobId)).toMatchObject({ result: 2 });
  });

  it("fails a job whose last attempt was interrupted", async () => {
    const store = createInMemoryJobStore();
    const { jobs } = setup(store);
    const job = jobs.define("last-try", { retries: 0, run: () => "never" });
    const { jobId } = await job.enqueue(null);
    await store.claim(["last-try"], "dead-worker", 30);
    jobs.start();
    await until(async () => (await job.get(jobId))?.status === "failed");
    expect((await job.get(jobId))?.error?.message).toMatch(/interrupted/);
  });
});

describe("execution policies and bounded shutdown", () => {
  it("requires explicit store support and validates execution deadlines", () => {
    const legacy = { ...createInMemoryJobStore(), capabilities: undefined };
    const { jobs } = setup(legacy);
    expect(() => jobs.define("legacy", { run: () => null })).not.toThrow();
    expect(() => jobs.define("paid", { onInterrupt: "fail", run: () => null })).toThrow(/execution policies/);
    expect(() => jobs.define("timed", { timeoutMs: 10, run: () => null })).toThrow(/execution policies/);
    const supported = setup().jobs;
    for (const timeoutMs of [0, -1, NaN, Infinity, 1.5])
      expect(() => supported.define("bad", { timeoutMs, run: () => null })).toThrow(/timeoutMs/);
  });

  it("persists policies and fails a reclaimed paid job before context or handler execution", async () => {
    const store = createInMemoryJobStore();
    const first = setup(store);
    const paid = first.jobs.define("paid", { timeoutMs: 1000, onInterrupt: "fail", retries: 5, run: () => null });
    const { jobId } = await paid.enqueue({ tenant: "workspace-a" });
    expect(await store.get(jobId)).toMatchObject({ timeoutMs: 1000, onInterrupt: "fail", maxAttempts: 6 });
    await store.claim(["paid"], "dead", 10);
    await sleep(20);
    let contexts = 0;
    let calls = 0;
    const next = createJobs({ store, pubsub: createInMemoryPubSub(), context: () => { contexts++; return {}; }, pollMs: 5 });
    started.push(next);
    // Definitions may change after a deploy. The queued record's policy still applies.
    next.define("paid", { run: () => { calls++; } });
    next.start();
    await until(async () => (await paid.get(jobId))?.status === "failed");
    expect(contexts).toBe(0);
    expect(calls).toBe(0);
    expect(await store.get(jobId)).toMatchObject({ attempt: 2, status: "failed", deadlineAt: null });
  });

  it("expired deadlines cannot be renewed and are reclaimable before the lease expires", async () => {
    const store = createInMemoryJobStore();
    await store.add({ id: "deadline", name: "j", input: null, key: null, runAt: Date.now(), maxAttempts: 2, timeoutMs: 10 });
    const first = await store.claim(["j"], "old", 60_000);
    expect(first).toMatchObject({ interrupted: false });
    await sleep(20);
    expect(await store.extend("deadline", "old", 60_000)).toBe(false);
    const second = await store.claim(["j"], "new", 60_000);
    expect(second).toMatchObject({ interrupted: true, attempt: 2 });
    expect(second!.deadlineAt!).toBeGreaterThan(first!.deadlineAt!);
    expect(await store.settle("deadline", "old", { status: "succeeded", result: "late" })).toBeNull();
  });

  it("fences late results/progress and keeps a timed-out handler's concurrency slot occupied", async () => {
    const { jobs, store } = setup();
    let finish!: () => void;
    let lateProgress!: () => Promise<void>;
    let secondStarted = false;
    const blocked = jobs.define("blocked", {
      concurrency: 1, timeoutMs: 40, retries: 3, onInterrupt: "fail",
      run: async ({ input, job }: { input: number; job: import("../src/jobs.ts").JobHandle }) => {
        if (input === 2) { secondStarted = true; return "second"; }
        lateProgress = () => job.progress({ late: true });
        await new Promise<void>((resolve) => { finish = resolve; });
        return "late success";
      },
    });
    const first = await blocked.enqueue(1);
    const second = await blocked.enqueue(2);
    jobs.start();
    await until(async () => (await blocked.get(first.jobId))?.status === "failed");
    const version = (await store.get(first.jobId))!.version;
    await lateProgress();
    await sleep(25);
    expect(secondStarted).toBe(false);
    expect((await store.get(first.jobId))!.version).toBe(version);
    finish();
    await until(async () => (await blocked.get(second.jobId))?.status === "succeeded");
    expect(await blocked.get(first.jobId)).toMatchObject({ status: "failed", version, attempt: 1 });
    expect((await blocked.get(first.jobId))?.error?.message).toMatch(/deadline/);
  });

  it.each(["return", "throw", "progress"])("enforces the persisted deadline when CPU work delays timers (%s)", async (action) => {
    const { jobs, store } = setup();
    let calls = 0;
    const job = jobs.define("cpu", { concurrency: 1, timeoutMs: 10, onInterrupt: "fail", retries: 2,
      run: async ({ job }) => {
        calls++;
        const until = Date.now() + 30;
        while (Date.now() < until) { /* Deliberately prevent the timeout callback from running. */ }
        if (action === "throw") throw new Error("ordinary late failure");
        if (action === "progress") await job.progress({ late: true });
        return "too late";
      },
    });
    const { jobId } = await job.enqueue(null);
    jobs.start();
    await until(async () => (await job.get(jobId))?.status === "failed");
    expect(calls).toBe(1);
    expect(await store.get(jobId)).toMatchObject({ status: "failed", progress: null, error: { message: "Job execution deadline exceeded" } });
  });

  it("retryable execution deadlines consume attempts and use a fresh deadline for each attempt", async () => {
    const { jobs } = setup();
    let calls = 0;
    const job = jobs.define("retry-timeout", { concurrency: 1, timeoutMs: 15, onInterrupt: "retry", retries: 1,
      backoff: { initialMs: 1, maxMs: 1 }, run: ({ job }) => {
        calls++;
        return new Promise((_, reject) => job.signal.addEventListener("abort", () => reject(job.signal.reason), { once: true }));
      },
    });
    const { jobId } = await job.enqueue(null);
    jobs.start();
    await until(async () => (await job.get(jobId))?.status === "failed");
    expect(calls).toBe(2);
    expect(await job.get(jobId)).toMatchObject({ status: "failed", attempt: 2, maxAttempts: 2 });
  });

  it("a durable schedule retains its cursor on registration and runs through the worker", async () => {
    const store = createInMemoryJobStore();
    const { jobs } = setup(store);
    const calendar = { kind: "daily" as const, hourUTC: 2, minuteUTC: 0 };
    let ran: unknown;
    const job = jobs.define("scheduled", { input: s.object({ workspaceId: s.integer() }),
      key: (input) => String(input.workspaceId), timeoutMs: 1000, onInterrupt: "fail", retries: 0,
      run: ({ input }) => { ran = input; },
    });
    const past = Date.now() - 5_000;
    await store.putSchedule({ id: "daily", name: "scheduled", input: { workspaceId: 7 }, key: "7",
      maxAttempts: 1, timeoutMs: 1000, onInterrupt: "fail", calendar, nextRunAt: past,
    });
    await job.schedule("daily", { workspaceId: 7 }, calendar);
    expect(await store.dueSchedules(["scheduled"], Date.now())).toMatchObject([{ nextRunAt: past }]);
    jobs.start();
    await until(() => ran !== undefined);
    expect(ran).toEqual({ workspaceId: 7 });
    expect(await store.dueSchedules(["scheduled"], Date.now())).toEqual([]);
    await jobs.unschedule("daily");
    expect(await store.dueSchedules(["scheduled"], Number.MAX_SAFE_INTEGER)).toEqual([]);
  });

  it("memory schedule claims fence concurrent advancement and deletion/recreation", async () => {
    const store = createInMemoryJobStore();
    const config = { id: "daily", name: "j", input: null, key: null, maxAttempts: 1,
      calendar: { kind: "daily" as const, hourUTC: 2, minuteUTC: 0 }, nextRunAt: 100,
    };
    const old = await store.putSchedule(config);
    expect(await store.removeSchedule("daily")).toBe(true);
    const current = await store.putSchedule(config);
    expect(current.revision).toBeGreaterThan(old.revision);
    const record = { id: "occurrence", name: "j", input: null, key: null, maxAttempts: 1, runAt: 100 };
    expect(await store.advanceSchedule(old, 200, record)).toBe(false);
    const won = await Promise.all([store.advanceSchedule(current, 200, record), store.advanceSchedule(current, 200, { ...record, id: "duplicate" })]);
    expect(won.sort()).toEqual([false, true]);
    const claims = await Promise.all([store.claim(["j"], "a", 1000), store.claim(["j"], "b", 1000)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
  });

  it("allows work to complete during the shutdown grace period", async () => {
    const { jobs } = setup();
    let finish!: () => void;
    let aborted = false;
    const job = jobs.define("grace", { onInterrupt: "fail", run: ({ job }) => {
      job.signal.addEventListener("abort", () => { aborted = true; });
      return new Promise<string>((resolve) => { finish = () => resolve("finished"); });
    } });
    const { jobId } = await job.enqueue(null);
    jobs.start();
    await until(() => !!finish);
    setTimeout(finish, 20);
    expect(await jobs.stop({ graceMs: 80, timeoutMs: 150 })).toEqual({ drained: true, pending: 0 });
    expect(aborted).toBe(false);
    expect(await job.get(jobId)).toMatchObject({ status: "succeeded", result: "finished" });
  });

  it("bounds shutdown of uncooperative paid work without refunding or accepting a late result", async () => {
    const { jobs, store } = setup();
    let finish!: () => void;
    const job = jobs.define("paid", { onInterrupt: "fail", retries: 3,
      run: () => new Promise<string>((resolve) => { finish = () => resolve("charged already"); }),
    });
    const { jobId } = await job.enqueue(null);
    jobs.start();
    await until(() => !!finish);
    const before = Date.now();
    expect(await jobs.stop({ timeoutMs: 35 })).toMatchObject({ drained: false, pending: 1 });
    expect(Date.now() - before).toBeLessThan(250);
    expect(await store.get(jobId)).toMatchObject({ status: "failed", attempt: 1 });
    finish();
    expect(await jobs.stop({ timeoutMs: 100 })).toMatchObject({ drained: true, pending: 0 });
    expect(await store.get(jobId)).toMatchObject({ status: "failed", attempt: 1 });
  });

  it("a context resolving after shutdown cannot start the handler", async () => {
    const store = createInMemoryJobStore();
    let release!: () => void;
    let called = false;
    const jobs = createJobs({ store, pubsub: createInMemoryPubSub(),
      context: () => new Promise<void>((resolve) => { release = resolve; }), pollMs: 5,
    });
    started.push(jobs);
    const job = jobs.define("context", { onInterrupt: "fail", run: () => { called = true; } });
    const { jobId } = await job.enqueue(null);
    jobs.start();
    await until(() => !!release);
    expect(await jobs.stop({ timeoutMs: 25 })).toMatchObject({ drained: false, pending: 1 });
    release();
    expect(await jobs.stop({ timeoutMs: 100 })).toMatchObject({ drained: true });
    expect(called).toBe(false);
    expect(await job.get(jobId)).toMatchObject({ status: "failed" });
  });

  it("a claim resolving after the shutdown budget settles without invoking the handler", async () => {
    const inner = createInMemoryJobStore();
    let release!: () => void;
    let called = false;
    const store: JobStore = { ...inner, async claim(names, token, lease) {
      await new Promise<void>((resolve) => { release = resolve; });
      return inner.claim(names, token, lease);
    } };
    const { jobs } = setup(store);
    const job = jobs.define("claim", { onInterrupt: "fail", run: () => { called = true; } });
    const { jobId } = await job.enqueue(null);
    jobs.start();
    await until(() => !!release);
    expect(await jobs.stop({ timeoutMs: 25 })).toMatchObject({ drained: false, pending: 1 });
    release();
    await until(async () => (await job.get(jobId))?.status === "failed");
    expect(called).toBe(false);
    expect(await jobs.stop({ timeoutMs: 100 })).toMatchObject({ drained: true });
  });

  it("reports settlement failures instead of claiming the worker drained", async () => {
    const inner = createInMemoryJobStore();
    const store: JobStore = { ...inner, async settle() { throw new Error("database unavailable"); } };
    const { jobs, errors } = setup(store);
    const job = jobs.define("settle", { onInterrupt: "fail", run: () => "done" });
    await job.enqueue(null);
    jobs.start();
    await until(() => errors.length > 0);
    const result = await jobs.stop({ timeoutMs: 30 });
    expect(result).toMatchObject({ drained: false, pending: 1, errors: [{ message: "database unavailable" }] });
    await expect(jobs.stop()).rejects.toThrow(/did not drain/);
  });

  it("clears a transient settlement error after the same worker recovers and settles the job", async () => {
    const inner = createInMemoryJobStore();
    let failOnce = true;
    const store: JobStore = { ...inner, async settle(...args) {
      if (failOnce) { failOnce = false; throw new Error("transient database failure"); }
      return inner.settle(...args);
    } };
    const { jobs, errors } = setup(store);
    let calls = 0;
    const job = jobs.define("recover-settlement", { onInterrupt: "fail", retries: 3, run: () => { calls++; return "charged"; } });
    const { jobId } = await job.enqueue(null);
    jobs.start();
    await until(() => errors.length === 1);
    await until(async () => (await job.get(jobId))?.status === "failed");
    expect(calls).toBe(1); // Recovery must settle the paid job without replaying its handler.
    expect(await jobs.stop({ timeoutMs: 100 })).toEqual({ drained: true, pending: 0 });
    await expect(jobs.stop()).resolves.toBeUndefined();
  });

  it("settles a success write delayed past its deadline before reporting shutdown drained", async () => {
    const inner = createInMemoryJobStore();
    let release!: () => void;
    const outcomes: string[] = [];
    const store: JobStore = { ...inner, async settle(id, token, outcome) {
      outcomes.push(outcome.status);
      if (outcome.status === "succeeded") await new Promise<void>((resolve) => { release = resolve; });
      return inner.settle(id, token, outcome);
    } };
    const { jobs } = setup(store);
    const job = jobs.define("late-settlement", { concurrency: 1, timeoutMs: 20, onInterrupt: "fail", run: () => "done" });
    const { jobId } = await job.enqueue(null);
    jobs.start();
    await until(() => !!release);
    const stopped = jobs.stop({ timeoutMs: 150 });
    await sleep(30);
    release();
    expect(await stopped).toEqual({ drained: true, pending: 0 });
    expect(outcomes).toEqual(["succeeded", "failed"]);
    expect(await store.get(jobId)).toMatchObject({ status: "failed", error: { message: "Job execution deadline exceeded" } });
  });

  it("bounds shutdown even when a settlement never resolves", async () => {
    const inner = createInMemoryJobStore();
    const store: JobStore = { ...inner, settle: () => new Promise(() => {}) };
    const { jobs } = setup(store);
    let ran = false;
    const job = jobs.define("hung-store", { run: () => { ran = true; } });
    await job.enqueue(null);
    jobs.start();
    await until(() => ran);
    expect(await jobs.stop({ timeoutMs: 25 })).toMatchObject({ drained: false, pending: 1 });
  });
});

describe(".background()", () => {
  type Ctx = { user?: { id: string; tenant: string } };
  const { route } = initDendra<Ctx>();
  const authed = route.use(({ ctx }) => {
    if (!ctx.user) throw new DendraError("UNAUTHORIZED", "sign in");
    return { user: ctx.user };
  });

  it("validates, guards, enqueues and returns { jobId }", async () => {
    const { jobs } = setup();
    const ran: unknown[] = [];
    const summarize = jobs.define("summarize", {
      input: s.object({ docId: s.string(), tenant: s.string() }),
      run: ({ input }) => {
        ran.push(input);
      },
    });
    const router = {
      summarize: authed
        .input(s.object({ docId: s.string() }))
        .background(summarize, ({ input, ctx }) => ({ docId: input.docId, tenant: ctx.user.tenant })),
      direct: route.input(s.object({ docId: s.string(), tenant: s.string() })).background(summarize),
    };

    await expect(createCaller(router, {}).summarize({ docId: "d1" })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(
      createCaller(router, { user: { id: "u", tenant: "t1" } }).summarize({ docId: 5 } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    const { jobId } = await createCaller(router, { user: { id: "u", tenant: "t1" } }).summarize({ docId: "d1" });
    expect(typeof jobId).toBe("string");
    await createCaller(router, {}).direct({ docId: "d2", tenant: "t2" });

    jobs.start();
    await until(() => ran.length === 2);
    expect(ran).toEqual(expect.arrayContaining([{ docId: "d1", tenant: "t1" }, { docId: "d2", tenant: "t2" }]));
  });
});

// The same contract, against each store.
const url = process.env.DENDRA_PG_URL;
const stores: [string, () => Promise<JobStore & { drop?: () => Promise<void> }>][] = [
  ["in-memory", async () => createInMemoryJobStore()],
];
if (url) {
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: url });
  afterAll(() => pool.end());
  let n = 0;
  stores.push([
    "postgres",
    async () => {
      const table = `dendra_jobs_test_${process.pid}_${n++}`;
      const store = createPgJobStore(pool, { table });
      await store.setup();
      return Object.assign(store, { drop: () => pool.query(`DROP TABLE "${table}"`).then(() => {}) });
    },
  ]);
}

describe.each(stores)("JobStore contract (%s)", (_name, make) => {
  let store: JobStore & { drop?: () => Promise<void> };
  afterEach(async () => {
    await store?.drop?.();
  });
  const job = (id: string, extra: Partial<{ key: string; runAt: number; name: string }> = {}) => ({
    id,
    name: extra.name ?? "j",
    key: extra.key ?? null,
    input: { id },
    maxAttempts: 3,
    runAt: extra.runAt ?? Date.now() - 1000,
  });

  it("raises the version on every visible change, not on a lease renewal", async () => {
    store = await make();
    await store.add(job("v"));
    expect((await store.get("v"))?.version).toBe(1);
    expect((await store.claim(["j"], "t", 1000))?.version).toBe(2);
    expect(await store.progress("v", "t", { step: 1 })).toBe(3);
    expect(await store.extend("v", "t", 1000)).toBe(true);
    expect((await store.get("v"))?.version).toBe(3);
    expect(await store.progress("v", "other-token", { step: 2 })).toBeNull();
    expect((await store.settle("v", "t", { status: "succeeded", result: 1 }))?.version).toBe(4);
  });

  it("dedupes active jobs by name and key", async () => {
    store = await make();
    expect(await store.add(job("a", { key: "k" }))).toEqual({ id: "a", created: true });
    expect(await store.add(job("b", { key: "k" }))).toEqual({ id: "a", created: false });
    expect(await store.add(job("c", { key: "k", name: "other" }))).toEqual({ id: "c", created: true });
    expect(await store.add(job("d"))).toEqual({ id: "d", created: true });
    expect(await store.add(job("e"))).toEqual({ id: "e", created: true }); // no key, no dedupe

    const claimed = await store.claim(["j"], "t", 1000);
    expect(claimed?.id).toBe("a");
    await store.settle("a", "t", { status: "succeeded", result: 1 });
    expect(await store.add(job("f", { key: "k" }))).toEqual({ id: "f", created: true });
  });

  it("claims due jobs once, in run order, and only for the given names", async () => {
    store = await make();
    await store.add(job("later", { runAt: Date.now() + 60_000 }));
    await store.add(job("second", { runAt: Date.now() - 1000 }));
    await store.add(job("first", { runAt: Date.now() - 2000 }));
    await store.add(job("elsewhere", { name: "other" }));

    // Three workers at once: each due job goes to exactly one of them.
    const claims = await Promise.all(["t1", "t2", "t3"].map((t) => store.claim(["j"], t, 1000)));
    const won = claims.filter((c) => c !== null);
    expect(won.map((c) => c.id).sort()).toEqual(["first", "second"]);
    expect(won[0]).toMatchObject({ status: "running", attempt: 1, input: { id: won[0].id } });

    await store.add(job("third", { runAt: Date.now() - 3000 }));
    expect((await store.claim(["j"], "t4", 1000))?.id).toBe("third"); // earliest run_at first
  });

  it("only the claim's token can write, and an expired lease can be reclaimed", async () => {
    store = await make();
    await store.add(job("a"));
    await store.claim(["j"], "old", 20);
    expect(await store.progress("a", "wrong", { p: 1 })).toBeNull();
    expect(await store.extend("a", "old", 20)).toBe(true);
    await sleep(60);

    const again = await store.claim(["j"], "new", 1000);
    expect(again).toMatchObject({ id: "a", attempt: 2 });
    expect(await store.settle("a", "old", { status: "succeeded", result: "stale" })).toBeNull();
    expect(await store.progress("a", "new", { p: 2 })).toEqual(expect.any(Number));
    expect(await store.settle("a", "new", { status: "succeeded", result: { ok: true } })).toMatchObject({
      status: "succeeded",
      result: { ok: true },
      progress: { p: 2 },
      error: null,
    });
  });

  it("requeues for a retry, refunding the attempt when asked", async () => {
    store = await make();
    await store.add(job("a"));
    await store.claim(["j"], "t", 1000);
    const err = { code: "INTERNAL" as const, message: "boom" };
    expect(
      await store.settle("a", "t", { status: "queued", error: err, runAt: Date.now() + 60_000, refund: false }),
    ).toMatchObject({ status: "queued", attempt: 1, error: err });
    expect(await store.claim(["j"], "t2", 1000)).toBeNull(); // not due yet

    await store.add(job("b"));
    await store.claim(["j"], "t3", 1000);
    expect(
      await store.settle("b", "t3", { status: "queued", error: null, runAt: Date.now() - 1, refund: true }),
    ).toMatchObject({ status: "queued", attempt: 0 });

    expect(await store.get("missing")).toBeNull();
  });

  it("runs jobs end to end", async () => {
    store = await make();
    const { jobs } = setup(store);
    const square = jobs.define("square", { input: s.object({ n: s.number() }), run: ({ input }) => input.n ** 2 });
    jobs.start();
    const { jobId } = await square.enqueue({ n: 7 });
    const seen: JobSnapshot<number>[] = await collect(square.watch(jobId));
    expect(seen.at(-1)).toMatchObject({ status: "succeeded", result: 49 });
  });
});
