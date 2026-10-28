// The background-job flow end to end, through the real RPC route and the typed
// client over SSE: start notes.digest, follow it with followJob to its result,
// and check another workspace can't watch it.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, followJob } from "dendra";
import type { AppRouter } from "../server/router.ts";

process.chdir(mkdtempSync(join(tmpdir(), "dendra-digest-")));
process.env.MCP_TOKENS = "acme:alice:tok-acme,beta:bob:tok-beta";

let route: { GET: (r: Request) => Promise<Response>; POST: (r: Request) => Promise<Response> };

beforeAll(async () => {
  route = await import("../app/rpc/[...path]/route.ts");
});

afterAll(async () => {
  const { jobs } = await import("../server/jobs.ts");
  await jobs.stop({ timeoutMs: 1000 });
});

// The browser client, with fetch going straight to the route handler.
function client(token: string) {
  return createClient<AppRouter>("http://localhost:3100", {
    prefix: "/rpc/",
    streamFormat: "sse",
    headers: { authorization: `Bearer ${token}` },
    fetch: ((url: string, init: RequestInit) => {
      const req = new Request(url, init);
      return req.method === "GET" ? route.GET(req) : route.POST(req);
    }) as typeof fetch,
  });
}

describe("notes.digest", () => {
  it("runs as a job that the client follows to its result", async () => {
    const acme = client("tok-acme");
    await acme.notes.create({ title: "one", body: "two three" });
    await acme.notes.create({ title: "four", body: "five" });

    const { jobId } = await acme.notes.digest();
    const progress: unknown[] = [];
    const f = followJob((signal) => acme.notes.digestStatus({ jobId }, { signal }));
    f.subscribe(({ job }) => {
      if (job?.status === "running" && job.progress) progress.push(job.progress);
    });
    const final = await f.done;

    expect(final.status).toBe("succeeded");
    if (final.status === "succeeded") expect(final.result).toEqual({ notes: 2, words: 5 });
    expect(progress).toContainEqual({ done: 2, total: 2 });
  });

  it("doesn't let another workspace watch the job", async () => {
    const { jobId } = await client("tok-acme").notes.digest();
    const f = followJob((signal) => client("tok-beta").notes.digestStatus({ jobId }, { signal }));
    await expect(f.done).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
