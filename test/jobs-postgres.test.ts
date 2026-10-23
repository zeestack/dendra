import { describe, it, expect, afterAll } from "vitest";
import { createJobs, createPgJobStore, createPgPubSub, s } from "../src/index.ts";

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
  afterAll(async () => {
    await pools[0]?.query(`DROP TABLE IF EXISTS "${table}"`);
    await Promise.all(pools.map((p) => p.end()));
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
});
