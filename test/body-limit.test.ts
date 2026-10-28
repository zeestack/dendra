import { describe, it, expect } from "vitest";
import { initDendra, toFetchHandler, toRestHandler, s, type RouterRecord } from "../src/index.ts";

// `maxBodyBytes` caps every request body, JSON included (#62) — not only
// multipart and form uploads (files-upload.test.ts covers those).

const { route } = initDendra();
const router = {
  echo: route.input(s.object({ text: s.string() })).handler(({ input }) => input.text.length),
  notes: {
    create: route
      .post("/notes")
      .input(s.object({ text: s.string() }))
      .handler(({ input }) => input.text.length),
  },
} satisfies RouterRecord;

const MAX = 1024;
const big = JSON.stringify({ text: "x".repeat(4096) });
const small = JSON.stringify({ text: "hi" });
const headers = { "content-type": "application/json", "x-dendra": "1" };

/** A JSON body streamed in 32-byte chunks with no Content-Length; counts pulls. */
function streamed(json: string) {
  const bytes = new TextEncoder().encode(json);
  const counter = { pulled: 0, chunks: Math.ceil(bytes.length / 32) };
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      if (counter.pulled >= counter.chunks) return c.close();
      c.enqueue(bytes.slice(counter.pulled * 32, ++counter.pulled * 32));
    },
  });
  return { body, counter };
}

const post = (url: string, body: string | ReadableStream<Uint8Array>, extra: Record<string, string> = {}) =>
  new Request(url, { method: "POST", body, headers: { ...headers, ...extra }, duplex: "half" } as RequestInit);

async function expect413(res: Response) {
  expect(res.status).toBe(413);
  expect(((await res.json()) as { error: { code: string } }).error.code).toBe("PAYLOAD_TOO_LARGE");
}

describe("maxBodyBytes on JSON bodies", () => {
  const rpc = toFetchHandler(router, { maxBodyBytes: MAX });
  const rest = toRestHandler(router, { maxBodyBytes: MAX });

  it("RPC: 413 past the cap, by Content-Length", async () => {
    await expect413(await rpc(post("http://x/rpc/echo", big, { "content-length": String(big.length) })));
  });

  it("RPC: 413 for a streamed body, without reading it all", async () => {
    const { body, counter } = streamed(big);
    await expect413(await rpc(post("http://x/rpc/echo", body)));
    expect(counter.pulled).toBeLessThan(counter.chunks);
  });

  it("RPC: under the cap still works", async () => {
    const res = await rpc(post("http://x/rpc/echo", small));
    expect(await res.json()).toEqual({ result: 2 });
  });

  it("batch: 413 past the cap", async () => {
    const calls = JSON.stringify([{ path: "echo", input: { text: "x".repeat(4096) } }]);
    const { body, counter } = streamed(calls);
    await expect413(await rpc(post("http://x/rpc/__batch", body)));
    expect(counter.pulled).toBeLessThan(counter.chunks);
  });

  it("REST: 413 past the cap", async () => {
    const { body, counter } = streamed(big);
    await expect413(await rest(post("http://x/notes", body)));
    expect(counter.pulled).toBeLessThan(counter.chunks);
  });

  it("REST: under the cap still works", async () => {
    const res = await rest(post("http://x/notes", small));
    expect(await res.json()).toBe(2);
  });

  it("defaults to 10 MB", async () => {
    const res = await toFetchHandler(router)(
      post("http://x/rpc/echo", small, { "content-length": String(11 * 1024 * 1024) }),
    );
    await expect413(res);
  });
});
