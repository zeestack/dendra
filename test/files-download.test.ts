import { describe, it, expect, vi } from "vitest";
import {
  initDendra,
  toFetchHandler,
  toRestHandler,
  createClient,
  createCaller,
  createToolExecutor,
  createWsSession,
  DendraClientError,
  DendraError,
  file,
  s,
  type AfterInfo,
  type FileOptions,
  type RouterRecord,
} from "../src/index.ts";

const { route } = initDendra();
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9]);

function makeRouter() {
  const seen: AfterInfo<unknown, unknown>[] = [];
  const record = (i: AfterInfo<unknown, unknown>) => void seen.push(i);
  const router = {
    covers: {
      get: route
        .get("/covers/:id")
        .input(s.object({ id: s.string() }))
        .handler(() =>
          file(PNG, {
            type: "image/webp",
            filename: "cover.webp",
            inline: true,
            cacheControl: "private, max-age=300",
          }),
        ),
    },
    drafts: {
      exportMarkdown: route
        .get()
        .input(s.object({ draftId: s.integer() }))
        .after(record)
        .handler(({ input }) => {
          if (input.draftId === 0) throw new DendraError("NOT_FOUND", "No draft");
          return file("# hi", { type: "text/markdown", filename: "draft.md" });
        }),
    },
    // Drives the header tests: returns "x" with whatever options were posted.
    raw: route
      .input(s.object({}).passthrough())
      .handler(({ input }) => file("x", input as unknown as FileOptions)),
    toolFile: route
      .ai()
      .after(record)
      .handler(() => file("x", { type: "text/plain" })),
    add: route
      .input(s.object({ a: s.number(), b: s.number() }))
      .handler(({ input }) => input.a + input.b),
  } satisfies RouterRecord;
  return { router, seen };
}

const json = { "content-type": "application/json" };
async function raw(opts: Partial<FileOptions>, headers: Record<string, string> = {}) {
  const { router } = makeRouter();
  return toFetchHandler(router)(
    new Request("http://x/rpc/raw", {
      method: "POST",
      headers: { ...json, ...headers },
      body: JSON.stringify({ type: "text/plain", ...opts }),
    }),
  );
}

describe("file() responses", () => {
  it("sends bytes with type, disposition, caching, nosniff and the dendra marker", async () => {
    const { router } = makeRouter();
    const res = await toFetchHandler(router)(new Request("http://x/rpc/covers.get?id=1"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/webp");
    expect(res.headers.get("content-disposition")).toMatch(/^inline; filename="cover\.webp"/);
    expect(res.headers.get("cache-control")).toBe("private, max-age=300");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-dendra")).toBe("file");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
  });

  it("works on REST too", async () => {
    const { router } = makeRouter();
    const res = await toRestHandler(router)(new Request("http://x/covers/1"));
    expect(res.headers.get("content-type")).toBe("image/webp");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
  });

  it("defaults to private, no-store and attachment", async () => {
    const res = await raw({});
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("content-disposition")).toBe("attachment");
    const inline = await raw({ inline: true });
    expect(inline.headers.get("content-disposition")).toBeNull();
  });

  it("sanitizes the filename into one well-formed header", async () => {
    const name = 'évil"\r\nSet-Cookie: x=1\\.md';
    const res = await raw({ filename: name });
    const cd = res.headers.get("content-disposition")!;
    expect(cd).not.toMatch(/[\r\n]/);
    const quoted = /filename="([^"]*)"/.exec(cd)![1];
    expect(quoted).not.toMatch(/["\\\r\n]/);
    expect(quoted).toBe("_vilSet-Cookie: x=1.md");
    const star = /filename\*=UTF-8''(\S+)/.exec(cd)![1];
    expect(decodeURIComponent(star)).toBe(name);
    expect(star).not.toMatch(/['()*]/);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("never renders active types inline unless explicitly allowed", async () => {
    for (const type of ["text/html", "IMAGE/SVG+XML; charset=utf-8", "application/atom+xml"]) {
      const res = await raw({ type, inline: true, filename: "a" });
      expect(res.headers.get("content-disposition")).toMatch(/^attachment;/);
    }
    const bare = await raw({ type: "text/html", inline: true });
    expect(bare.headers.get("content-disposition")).toBe("attachment");
    const allowed = await raw({ type: "image/svg+xml", inline: true, allowUnsafeInline: true });
    expect(allowed.headers.get("content-disposition")).toBeNull();
  });

  it("doesn't let custom headers override the safety headers", async () => {
    const res = await raw({
      headers: { "content-type": "text/html", "x-content-type-options": "", "x-extra": "1" },
    });
    expect(res.headers.get("content-type")).toBe("text/plain");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-extra")).toBe("1");
  });

  it("supports ETag / If-None-Match → 304", async () => {
    const first = await raw({ etag: "abc" });
    expect(first.headers.get("etag")).toBe('"abc"');
    const hit = await raw({ etag: "abc" }, { "if-none-match": 'W/"zzz", "abc"' });
    expect(hit.status).toBe(304);
    expect(await hit.text()).toBe("");
    const miss = await raw({ etag: "abc" }, { "if-none-match": '"zzz"' });
    expect(miss.status).toBe(200);
  });
});

describe("file() through clients and hooks", () => {
  it("the typed client returns a Blob, and errors stay DendraClientError", async () => {
    const { router } = makeRouter();
    const handler = toFetchHandler(router);
    const fetchImpl = ((i: string | URL | Request, init?: RequestInit) =>
      handler(new Request(typeof i === "string" ? i : i.toString(), init))) as typeof fetch;
    const api = createClient<typeof router>("http://x", { fetch: fetchImpl });
    const blob = await api.drafts.exportMarkdown({ draftId: 9 });
    expect(blob).toBeInstanceOf(Blob);
    expect(await blob.text()).toBe("# hi");
    await expect(api.drafts.exportMarkdown({ draftId: 0 })).rejects.toBeInstanceOf(
      DendraClientError,
    );
  });

  it("createCaller returns a Blob too", async () => {
    const { router } = makeRouter();
    const blob = await createCaller(router).drafts.exportMarkdown({ draftId: 9 });
    expect(await blob.text()).toBe("# hi");
  });

  it("after-hooks get file metadata, never the body", async () => {
    const { router, seen } = makeRouter();
    await createCaller(router).drafts.exportMarkdown({ draftId: 9 });
    expect(seen[0].result).toEqual({
      file: { type: "text/markdown", filename: "draft.md", size: 4 },
    });
  });

  it("a tool returning a file fails, and the after-hook records it", async () => {
    const { router, seen } = makeRouter();
    await expect(createToolExecutor(router, {})("toolFile", {})).rejects.toThrow(
      "Tool 'toolFile' returned a file; file outputs can't be tool results",
    );
    expect(seen.map((i) => [i.ok, i.code])).toEqual([[false, "NOT_IMPLEMENTED"]]);
  });

  it("batch and WebSocket calls get a per-call NOT_IMPLEMENTED", async () => {
    const { router } = makeRouter();
    const res = await toFetchHandler(router)(
      new Request("http://x/rpc/__batch", {
        method: "POST",
        headers: json,
        body: JSON.stringify([
          { path: "drafts.exportMarkdown", input: { draftId: 9 } },
          { path: "add", input: { a: 1, b: 2 } },
        ]),
      }),
    );
    const out = (await res.json()) as Array<{ result?: unknown; error?: { code: string; message: string } }>;
    expect(out[0].error!.code).toBe("NOT_IMPLEMENTED");
    expect(out[0].error!.message).toContain("aren't supported over batch");
    expect(out[1].result).toBe(3);

    const sent: string[] = [];
    const ws = createWsSession(router, (m) => void sent.push(m), {});
    ws.handleMessage(
      JSON.stringify({ id: 1, type: "call", path: "drafts.exportMarkdown", input: { draftId: 9 } }),
    );
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const msg = JSON.parse(sent[0]) as { error: { code: string; message: string } };
    expect(msg.error.code).toBe("NOT_IMPLEMENTED");
    expect(msg.error.message).toContain("WebSocket");
  });
});
