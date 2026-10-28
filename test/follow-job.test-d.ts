import { expectTypeOf } from "vitest";
import {
  createClient,
  createInMemoryJobStore,
  createInMemoryPubSub,
  createJobs,
  followJob,
  initDendra,
  s,
  type FollowedJob,
  type JobConnection,
  type ClientOptions,
  type ErrorCode,
} from "../src/index.ts";
import { useJob } from "../src/react.ts";

const jobs = createJobs({
  store: createInMemoryJobStore(),
  pubsub: createInMemoryPubSub(),
  context: () => ({}),
});
const summarize = jobs.define("summarize", {
  input: s.object({ docId: s.string() }),
  run: async () => ({ summary: "…", words: 3 }),
});
const { route } = initDendra();
const router = {
  start: route.input(s.object({ docId: s.string() })).background(summarize),
  watch: route
    .input(s.object({ jobId: s.string() }))
    .stream(({ input, signal }) => summarize.watch(input.jobId, { signal })),
};
const api = createClient<typeof router>("");

// The snapshot type flows from the job's `run` through the client's stream.
const f = followJob((signal) => api.watch({ jobId: "j" }, { signal }));
const state = f.get();
expectTypeOf(state.connection).toEqualTypeOf<JobConnection>();
expectTypeOf(state.error).toEqualTypeOf<(Error & { code?: string }) | null>();

const job = state.job;
if (job) {
  // `result` is only the job's output once status says it succeeded.
  // @ts-expect-error — not narrowed yet: result may be undefined
  job.result.summary;
  if (job.status === "succeeded") {
    expectTypeOf(job.result).toEqualTypeOf<{ summary: string; words: number }>();
    expectTypeOf(job.error).toEqualTypeOf<null>();
  }
  if (job.status === "failed") {
    expectTypeOf(job.error).toEqualTypeOf<{ code: ErrorCode; message: string }>();
    // Over JSON a failed job has no `result` key at all.
    expectTypeOf(job).not.toHaveProperty("result");
  }
}

// `done` resolves with the same snapshot type.
type Snap = NonNullable<typeof state.job>;
expectTypeOf(f.done).toEqualTypeOf<Promise<Snap>>();

// useJob returns the same state; the id may be absent.
declare const id: string | null;
const followed = useJob(id, (jobId, signal) => api.watch({ jobId }, { signal }));
expectTypeOf(followed).toEqualTypeOf<FollowedJob<Snap>>();

// The watch must yield something with status and version.
// @ts-expect-error — numbers aren't job snapshots
followJob((signal) => (async function* () { yield 1; })());

// streamFormat accepts only the two wire formats.
expectTypeOf<ClientOptions["streamFormat"]>().toEqualTypeOf<"ndjson" | "sse" | undefined>();
// @ts-expect-error — not a format
createClient<typeof router>("", { streamFormat: "websocket" });
