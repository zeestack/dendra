import { describe, it, expect, afterEach } from "vitest";
import {
  createClient,
  createInMemoryJobStore,
  createInMemoryPubSub,
  createJobs,
  DendraClientError,
  followJob,
  initDendra,
  s,
  toFetchHandler,
  type FollowedJob,
  type Jobs,
  type JobSnapshotLike,
} from "../src/index.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fast = { backoff: { initialMs: 1, maxMs: 1 } };

type Snap = JobSnapshotLike & { progress?: unknown };
const snap = (version: number, status = "running", progress: unknown = null): Snap => ({
  version,
  status,
  progress,
});

// A watch whose every opening is scripted: values to yield, then how it ends.
function scripted(runs: Array<{ yields: Snap[]; then?: "end" | "hang" | unknown }>) {
  const opened: AbortSignal[] = [];
  const open = (signal: AbortSignal): AsyncIterable<Snap> => {
    opened.push(signal);
    const run = runs[Math.min(opened.length - 1, runs.length - 1)];
    return (async function* () {
      for (const y of run.yields) yield y;
      if (run.then === "hang") {
        await new Promise<void>((r) => signal.addEventListener("abort", () => r(), { once: true }));
        return;
      }
      if (run.then !== undefined && run.then !== "end") throw run.then;
    })();
  };
  return { open, opened };
}

describe("followJob", () => {
  it("reports each snapshot and resolves done with the final one", async () => {
    const { open } = scripted([{ yields: [snap(1, "queued"), snap(2), snap(3, "running", 50), snap(4, "succeeded")] }]);
    const seen: FollowedJob<Snap>[] = [];
    const f = followJob(open);
    f.subscribe((st) => seen.push(st));
    expect(await f.done).toEqual(snap(4, "succeeded"));
    expect(seen.map((x) => x.job?.version)).toEqual([1, 2, 3, 4, 4]);
    expect(f.get()).toMatchObject({ connection: "ended", error: null });
  });

  it("reconnects after a network error and drops states it already showed", async () => {
    const { open, opened } = scripted([
      { yields: [snap(1), snap(2)], then: new TypeError("fetch failed") },
      { yields: [snap(2), snap(3, "failed")] },
    ]);
    const connections: string[] = [];
    const versions: number[] = [];
    const f = followJob(open, fast);
    f.subscribe((st) => {
      connections.push(st.connection);
      if (st.job && versions.at(-1) !== st.job.version) versions.push(st.job.version);
    });
    expect((await f.done).status).toBe("failed");
    expect(opened).toHaveLength(2);
    expect(versions).toEqual([1, 2, 3]);
    expect(connections).toContain("reconnecting");
  });

  it("reconnects on UNAVAILABLE and when the stream ends before a final state", async () => {
    const { open, opened } = scripted([
      { yields: [snap(1)], then: new DendraClientError({ code: "UNAVAILABLE", message: "lost" }) },
      { yields: [snap(2)], then: "end" },
      { yields: [snap(3, "succeeded")] },
    ]);
    expect((await followJob(open, fast).done).version).toBe(3);
    expect(opened).toHaveLength(3);
  });

  it("stops with error on a coded failure like NOT_FOUND", async () => {
    const notFound = new DendraClientError({ code: "NOT_FOUND", message: "No job 'x'" });
    const { open, opened } = scripted([{ yields: [], then: notFound }]);
    const f = followJob(open, fast);
    await expect(f.done).rejects.toBe(notFound);
    expect(f.get()).toMatchObject({ job: null, connection: "ended", error: { code: "NOT_FOUND" } });
    expect(opened).toHaveLength(1);
  });

  it("stop() aborts the open watch and rejects done with an AbortError", async () => {
    const { open, opened } = scripted([{ yields: [snap(1)], then: "hang" }]);
    const f = followJob(open);
    await sleep(5);
    expect(f.get().connection).toBe("live");
    f.stop();
    await expect(f.done).rejects.toMatchObject({ name: "AbortError" });
    expect(opened[0].aborted).toBe(true);
    expect(f.get()).toMatchObject({ connection: "ended", error: null });
  });

  it("retries at once when the browser comes back online", async () => {
    const { open, opened } = scripted([
      { yields: [snap(1)], then: new TypeError("offline") },
      { yields: [snap(2, "succeeded")] },
    ]);
    const online = new EventTarget();
    const f = followJob(open, { backoff: { initialMs: 60_000 }, online });
    await sleep(5);
    expect(f.get().connection).toBe("reconnecting");
    online.dispatchEvent(new Event("online"));
    expect((await f.done).version).toBe(2);
    expect(opened).toHaveLength(2);
  });

  it("an aborted signal stops it, including during a backoff wait", async () => {
    const { open, opened } = scripted([{ yields: [], then: new TypeError("offline") }]);
    const ac = new AbortController();
    const f = followJob(open, { signal: ac.signal, backoff: { initialMs: 60_000 } });
    await sleep(5);
    expect(f.get().connection).toBe("reconnecting");
    ac.abort();
    await expect(f.done).rejects.toMatchObject({ name: "AbortError" });
    expect(opened).toHaveLength(1);
  });
});

describe("followJob over HTTP", () => {
  const started: Jobs<unknown>[] = [];
  afterEach(async () => {
    await Promise.all(started.splice(0).map((j) => j.stop({ timeoutMs: 100 })));
  });

  it("follows a .background() job through progress to its typed result", async () => {
    const jobs = createJobs({
      store: createInMemoryJobStore(),
      pubsub: createInMemoryPubSub(),
      context: () => ({}),
      pollMs: 5,
    });
    started.push(jobs as Jobs<unknown>);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const summarize = jobs.define("summarize", {
      input: s.object({ docId: s.string() }),
      run: async ({ input, job }) => {
        await job.progress({ pct: 50 });
        await gate;
        return { summary: `doc ${input.docId}` };
      },
    });
    const { route } = initDendra();
    const router = {
      start: route.input(s.object({ docId: s.string() })).background(summarize),
      watch: route
        .input(s.object({ jobId: s.string() }))
        .stream(({ input, signal }) => summarize.watch(input.jobId, { signal })),
    };
    const handler = toFetchHandler(router);
    const api = createClient<typeof router>("http://local", {
      fetch: ((i: string | URL | Request, init?: RequestInit) =>
        handler(new Request(String(i), init))) as typeof fetch,
    });

    const { jobId } = await api.start({ docId: "d1" });
    const f = followJob((signal) => api.watch({ jobId }, { signal }));
    const progress: unknown[] = [];
    f.subscribe(({ job }) => {
      if (job && progress.at(-1) !== job.progress) progress.push(job.progress);
      if ((job?.progress as { pct?: number } | null)?.pct === 50) release();
    });
    jobs.start();
    const final = await f.done;
    expect(final.status).toBe("succeeded");
    if (final.status === "succeeded") expect(final.result.summary).toBe("doc d1");
    expect(progress).toContainEqual({ pct: 50 });
  });

  it("reports a watch's NOT_FOUND as error", async () => {
    const jobs = createJobs({ store: createInMemoryJobStore(), pubsub: createInMemoryPubSub(), context: () => ({}) });
    const j = jobs.define("noop", { run: () => null });
    const { route } = initDendra();
    const router = {
      watch: route
        .input(s.object({ jobId: s.string() }))
        .stream(({ input, signal }) => j.watch(input.jobId, { signal })),
    };
    const handler = toFetchHandler(router);
    const api = createClient<typeof router>("http://local", {
      fetch: ((i: string | URL | Request, init?: RequestInit) =>
        handler(new Request(String(i), init))) as typeof fetch,
    });
    const f = followJob((signal) => api.watch({ jobId: "nope" }, { signal }));
    await expect(f.done).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(f.get().error).toBeInstanceOf(DendraClientError);
  });
});
