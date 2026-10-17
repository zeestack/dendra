import { describe, it, expect, vi } from "vitest";
import {
  initDendra,
  toFetchHandler,
  toRestHandler,
  createClient,
  s,
  type RouterRecord,
} from "../src/index.ts";

const { route } = initDendra();

const approved = vi.fn(() => "approved");
const router = {
  approve: route.handler(approved),
  add: route
    .input(s.object({ a: s.number(), b: s.number() }))
    .handler(({ input }) => input.a + input.b),
  notes: {
    get: route
      .get()
      .input(s.object({ id: s.string() })) // RPC GET passes query values as strings
      .handler(({ input }) => ({ id: input.id })),
    create: route
      .post("/notes")
      .input(s.object({ title: s.string() }))
      .handler(({ input }) => input),
    remove: route.delete("/notes/:id").handler(() => "gone"),
  },
} satisfies RouterRecord;

const rpc = toFetchHandler(router);
const rest = toRestHandler(router);

async function code(res: Response) {
  return ((await res.json()) as { error?: { code: string } }).error?.code;
}

describe("CSRF: GET only reaches reads", () => {
  it("rejects GET on a procedure not declared .get() without running it", async () => {
    approved.mockClear();
    const res = await rpc(new Request("http://x/rpc/approve"));
    expect(res.status).toBe(405);
    expect(await code(res)).toBe("METHOD_NOT_ALLOWED");
    expect(approved).not.toHaveBeenCalled();
  });

  it("rejects HEAD and other methods on non-reads without running them", async () => {
    approved.mockClear();
    for (const method of ["HEAD", "PUT", "DELETE", "PATCH"]) {
      const res = await rpc(new Request("http://x/rpc/approve", { method }));
      expect(res.status).toBe(405);
    }
    expect(approved).not.toHaveBeenCalled();
  });

  it("answers GET for a .get() read", async () => {
    const res = await rpc(new Request("http://x/rpc/notes.get?id=1"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: { id: "1" } });
  });
});

describe("CSRF: POST must be JSON", () => {
  it("rejects a bodiless POST with no content-type (no-cors simple request)", async () => {
    approved.mockClear();
    const res = await rpc(new Request("http://x/rpc/approve", { method: "POST" }));
    expect(res.status).toBe(415);
    expect(await code(res)).toBe("UNSUPPORTED_MEDIA_TYPE");
    expect(approved).not.toHaveBeenCalled();
  });

  it("rejects a text/plain body even when it is valid JSON", async () => {
    const res = await rpc(
      new Request("http://x/rpc/add", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: '{"a":1,"b":2}',
      }),
    );
    expect(res.status).toBe(415);
  });

  it("rejects urlencoded form posts by default", async () => {
    const res = await rpc(
      new Request("http://x/rpc/add", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "a=1&b=2",
      }),
    );
    expect(res.status).toBe(415);
  });

  it("accepts application/json with parameters", async () => {
    const res = await rpc(
      new Request("http://x/rpc/add", {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: '{"a":1,"b":2}',
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: 3 });
  });

  it("applies to __batch", async () => {
    const res = await rpc(
      new Request("http://x/rpc/__batch", {
        method: "POST",
        body: JSON.stringify([{ path: "add", input: { a: 1, b: 2 } }]),
      }),
    );
    expect(res.status).toBe(415);
  });

  it("REST: rejects POST without JSON, allows a bodiless DELETE", async () => {
    const post = await rest(
      new Request("http://x/notes", { method: "POST", body: '{"title":"x"}' }),
    );
    expect(post.status).toBe(415);
    const del = await rest(new Request("http://x/notes/1", { method: "DELETE" }));
    expect(del.status).toBe(200);
  });
});

describe("typed client sends X-Dendra", () => {
  it("on single calls and on batches", async () => {
    const seen: Array<{ url: string; dendra: string | null }> = [];
    const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
      const req = new Request(typeof input === "string" ? input : input.toString(), init);
      seen.push({ url: req.url, dendra: req.headers.get("x-dendra") });
      return rpc(req);
    }) as typeof fetch;

    const api = createClient<typeof router>("http://x", { fetch: fetchImpl });
    expect(await api.add({ a: 1, b: 2 })).toBe(3);
    const batched = createClient<typeof router>("http://x", { fetch: fetchImpl, batch: true });
    expect(await Promise.all([batched.add({ a: 1, b: 1 }), batched.add({ a: 2, b: 2 })])).toEqual([
      2, 4,
    ]);
    expect(seen.map((r) => r.dendra)).toEqual(["1", "1"]);
    expect(seen[1].url).toContain("__batch");
  });
});
