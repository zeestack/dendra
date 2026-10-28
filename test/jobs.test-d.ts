import { expectTypeOf } from "vitest";
import {
  createClient,
  createInMemoryJobStore,
  createInMemoryPubSub,
  createJobs,
  initDendra,
  s,
  type JobSnapshot,
} from "../src/index.ts";

const jobs = createJobs({
  store: createInMemoryJobStore(),
  pubsub: createInMemoryPubSub(),
  context: () => ({ db: 1 }),
});

// Input comes from the schema, output from `run`, ctx from `context`.
const summarize = jobs.define("summarize", {
  input: s.object({ docId: s.string(), tenant: s.string() }),
  run: async ({ input, ctx }) => {
    expectTypeOf(input).toEqualTypeOf<{ docId: string; tenant: string }>();
    expectTypeOf(ctx).toEqualTypeOf<{ db: number }>();
    return { words: 3 };
  },
});
expectTypeOf(summarize.enqueue).parameter(0).toEqualTypeOf<{ docId: string; tenant: string }>();

// Without a schema, input comes from `run`'s annotation.
const ping = jobs.define("ping", { run: ({ input }: { input: number }) => input });
expectTypeOf(ping.enqueue).parameter(0).toEqualTypeOf<number>();

// Snapshots narrow on status.
declare const snap: JobSnapshot<{ words: number }>;
if (snap.status === "succeeded") expectTypeOf(snap.result).toEqualTypeOf<{ words: number }>();
if (snap.status === "failed") expectTypeOf(snap.error.message).toEqualTypeOf<string>();

const { route } = initDendra<{ tenant: string }>();
const router = {
  // The procedure's input already fits the job's.
  direct: route.input(s.object({ docId: s.string(), tenant: s.string() })).background(summarize),
  // `map` carries ctx into the job's input.
  mapped: route
    .input(s.object({ docId: s.string() }))
    .background(summarize, ({ input, ctx }) => ({ docId: input.docId, tenant: ctx.tenant })),
};

// @ts-expect-error — the procedure's input lacks `tenant`, so it needs a map
route.input(s.object({ docId: s.string() })).background(summarize);

route
  .input(s.object({ docId: s.string() }))
  // @ts-expect-error — map must return the job's input
  .background(summarize, ({ input }) => ({ docId: input.docId }));

const api = createClient<typeof router>("");
expectTypeOf(api.mapped).returns.resolves.toEqualTypeOf<{ jobId: string }>();
expectTypeOf(api.mapped).parameter(0).toEqualTypeOf<{ docId: string }>();

// Execution policy options and bounded shutdown preserve inference and the legacy signature.
const paid = jobs.define("paid", { input: s.object({ id: s.string() }), timeoutMs: 1000, onInterrupt: "fail", retries: 0,
  run: ({ input, job }) => { expectTypeOf(job.signal).toEqualTypeOf<AbortSignal>(); return input.id; },
});
expectTypeOf(paid.enqueue).parameter(0).toEqualTypeOf<{ id: string }>();
expectTypeOf(jobs.stop()).toEqualTypeOf<Promise<void>>();
expectTypeOf(jobs.stop({ graceMs: 10, timeoutMs: 20 })).resolves.toMatchTypeOf<{ drained: boolean; pending: number }>();
paid.schedule("daily", { id: "one" }, { kind: "daily", hourUTC: 2, minuteUTC: 0 });
// @ts-expect-error schedule input is the job's validated input
paid.schedule("daily", { id: 1 }, { kind: "daily", hourUTC: 2, minuteUTC: 0 });
// @ts-expect-error invalid interruption policy
jobs.define("bad-policy", { onInterrupt: "refund", run: () => null });
