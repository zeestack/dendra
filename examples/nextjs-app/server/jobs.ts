// Background jobs. A job runs on a worker with its own ctx (from `context`),
// never the request's — so the tenant travels in the job's input, and the
// watch procedure checks it before streaming status.
//
// In-memory store: fine for this single-process demo. Use createPgJobStore for
// anything that must survive a restart or run on more than one instance.

import { createInMemoryJobStore, createJobs, s, type Jobs, type JobStore } from "dendra";
import { db } from "./db.ts";
import { pubsub } from "./pubsub.ts";

type JobCtx = { db: typeof db };

const g = globalThis as unknown as { __dendraJobStore?: JobStore; __dendraJobs?: Jobs<JobCtx> };

// One instance across Next dev reloads, like the pub/sub. The store is kept
// too: a snapshot has no input, and the watch guard reads the job's tenant.
export const jobStore: JobStore = (g.__dendraJobStore ??= createInMemoryJobStore());
export const jobs: Jobs<JobCtx> = (g.__dendraJobs ??= createJobs<JobCtx>({
  store: jobStore,
  pubsub,
  context: () => ({ db }),
  pollMs: 200,
}));

// Counts the workspace's notes and words, one note at a time, reporting
// progress as it goes. The pause stands in for real per-item work.
export const digest = jobs.define("notes.digest", {
  input: s.object({ tenantId: s.string() }),
  retries: 0,
  run: async ({ input, ctx, job }) => {
    const notes = await ctx.db.notes.all(input.tenantId);
    let words = 0;
    for (const [i, n] of notes.entries()) {
      words += `${n.title} ${n.body}`.split(/\s+/).filter(Boolean).length;
      await job.progress({ done: i + 1, total: notes.length });
      await new Promise((r) => setTimeout(r, 150));
    }
    return { notes: notes.length, words };
  },
});

let started = false;
/** Start the workers on first use, so tests and builds that never enqueue don't. */
export function ensureJobsStarted(): void {
  if (started) return;
  started = true;
  jobs.start();
}
