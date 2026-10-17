import { describe, it, expect } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  initDendra,
  toFetchHandler,
  toNodeHandler,
  toRestHandler,
  createClient,
  DendraClientError,
  DendraError,
  s,
  type AfterInfo,
  type RouterRecord,
} from "../src/index.ts";

interface Ctx {
  workspaceId: number;
}
const { route } = initDendra<Ctx>();

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const pngFile = () => new File([PNG], "a.png", { type: "image/png" });

function makeRouter() {
  const seen: AfterInfo<unknown, unknown>[] = [];
  let ran = 0;
  const tenant = route
    .after((i) => void seen.push(i as AfterInfo<unknown, unknown>))
    .input(
      s.object({
        workspaceId: s.integer(),
        image: s.file({ types: ["image/png", "image/jpeg", "image/webp"], maxBytes: 8_000_000 }),
      }),
    )
    .use(({ ctx, input }) => {
      if (input.workspaceId !== ctx.workspaceId) throw new DendraError("FORBIDDEN", "Wrong workspace");
    });
  const router = {
    covers: {
      upload: tenant.post("/covers").handler(({ input }) => {
        ran++;
        return { name: input.image.name, size: input.image.size };
      }),
    },
    add: route
      .input(s.object({ a: s.number(), b: s.number() }))
      .handler(({ input }) => input.a + input.b),
  } satisfies RouterRecord;
  return { router, seen, ran: () => ran };
}

const createContext = () => ({ workspaceId: 3 });

function clientFor(handler: (r: Request) => Promise<Response>, batch = false) {
  const urls: string[] = [];
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(typeof input === "string" ? input : input.toString(), init);
    urls.push(new URL(req.url).pathname);
    return handler(req);
  }) as typeof fetch;
  return { urls, fetchImpl, batch };
}

describe("multipart uploads", () => {
  it("round-trips a file through the typed client and RPC handler", async () => {
    const { router } = makeRouter();
    const { fetchImpl } = clientFor(toFetchHandler(router, { createContext }));
    const api = createClient<typeof router>("http://x", { fetch: fetchImpl });
    expect(await api.covers.upload({ workspaceId: 3, image: pngFile() })).toEqual({
      name: "a.png",
      size: PNG.length,
    });
  });

  it("runs .use() before the handler and .after() sees the rejection", async () => {
    const { router, seen, ran } = makeRouter();
    const { fetchImpl } = clientFor(toFetchHandler(router, { createContext }));
    const api = createClient<typeof router>("http://x", { fetch: fetchImpl });
    const err = await api.covers.upload({ workspaceId: 4, image: pngFile() }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(DendraClientError);
    expect((err as DendraClientError).code).toBe("FORBIDDEN");
    expect(ran()).toBe(0);
    expect(seen.map((i) => i.code)).toEqual(["FORBIDDEN"]);
  });

  it("rejects multipart without X-Dendra (cross-site form) with 403", async () => {
    const { router, ran } = makeRouter();
    const fd = new FormData();
    fd.set("$input", JSON.stringify({ workspaceId: 3 }));
    fd.set("image", pngFile());
    const res = await toFetchHandler(router, { createContext })(
      new Request("http://x/rpc/covers.upload", { method: "POST", body: fd }),
    );
    expect(res.status).toBe(403);
    expect(ran()).toBe(0);
  });

  it("accepts a plain form post only with allowFormPosts, coercing fields on REST", async () => {
    const { router } = makeRouter();
    const fd = new FormData();
    fd.set("workspaceId", "3");
    fd.set("image", pngFile());
    const res = await toRestHandler(router, { createContext, allowFormPosts: true })(
      new Request("http://x/covers", { method: "POST", body: fd }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: "a.png", size: PNG.length });
  });

  it("REST multipart from a dendra-style request", async () => {
    const { router } = makeRouter();
    const fd = new FormData();
    fd.set("$input", JSON.stringify({ workspaceId: 3 }));
    fd.set("image", pngFile());
    const res = await toRestHandler(router, { createContext })(
      new Request("http://x/covers", { method: "POST", body: fd, headers: { "x-dendra": "1" } }),
    );
    expect(res.status).toBe(200);
  });

  it("413 when Content-Length is over maxBodyBytes", async () => {
    const { router } = makeRouter();
    const res = await toFetchHandler(router, { createContext, maxBodyBytes: 1024 })(
      new Request("http://x/rpc/covers.upload", {
        method: "POST",
        body: new Uint8Array(2048),
        headers: {
          "content-type": "multipart/form-data; boundary=x",
          "content-length": "2048",
          "x-dendra": "1",
        },
      }),
    );
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "PAYLOAD_TOO_LARGE",
    );
  });

  it("413 for a streamed body with no Content-Length, without reading it all", async () => {
    const { router } = makeRouter();
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        if (pulled >= 64) return c.close();
        pulled++;
        c.enqueue(new Uint8Array(32));
      },
    });
    const res = await toFetchHandler(router, { createContext, maxBodyBytes: 1024 })(
      new Request("http://x/rpc/covers.upload", {
        method: "POST",
        body,
        duplex: "half",
        headers: { "content-type": "multipart/form-data; boundary=x", "x-dendra": "1" },
      } as RequestInit),
    );
    expect(res.status).toBe(413);
    expect(pulled).toBeLessThan(64);
  });

  it("toNodeHandler: uploads binary intact and caps chunked bodies", async () => {
    const { router } = makeRouter();
    const server = createServer(toNodeHandler(router, { createContext, maxBodyBytes: 1024 }));
    await new Promise<void>((r) => server.listen(0, r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const api = createClient<typeof router>(base);
      expect(await api.covers.upload({ workspaceId: 3, image: pngFile() })).toEqual({
        name: "a.png",
        size: PNG.length,
      });

      let sent = 0;
      const res = await fetch(base + "/rpc/covers.upload", {
        method: "POST",
        duplex: "half",
        headers: { "content-type": "multipart/form-data; boundary=x", "x-dendra": "1" },
        body: new ReadableStream<Uint8Array>({
          pull(c) {
            if (sent >= 64) return c.close();
            sent++;
            c.enqueue(new Uint8Array(32));
          },
        }),
      } as RequestInit);
      expect(res.status).toBe(413);
    } finally {
      server.close();
    }
  });

  it("file calls skip the batch; JSON calls in the same tick still batch", async () => {
    const { router } = makeRouter();
    const { fetchImpl, urls } = clientFor(toFetchHandler(router, { createContext }));
    const api = createClient<typeof router>("http://x", { fetch: fetchImpl, batch: true });
    const [up, sum] = await Promise.all([
      api.covers.upload({ workspaceId: 3, image: pngFile() }),
      api.add({ a: 1, b: 2 }),
    ]);
    expect(up.name).toBe("a.png");
    expect(sum).toBe(3);
    expect(urls.sort()).toEqual(["/rpc/__batch", "/rpc/covers.upload"]);
  });
});

describe("toNodeHandler body handling", () => {
  it("survives the rest of an over-cap upload arriving after the 413", async () => {
    const { router } = makeRouter();
    const server = createServer(toNodeHandler(router, { createContext, maxBodyBytes: 1024 }));
    await new Promise<void>((r) => server.listen(0, r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const res = await fetch(base + "/rpc/covers.upload", {
        method: "POST",
        headers: { "content-type": "multipart/form-data; boundary=x", "x-dendra": "1" },
        body: new Uint8Array(512 * 1024),
      });
      expect(res.status).toBe(413);
      await new Promise((r) => setTimeout(r, 100)); // let the body finish arriving
      const api = createClient<typeof router>(base);
      expect(await api.add({ a: 1, b: 2 })).toBe(3);
    } finally {
      server.close();
    }
  });

  it("keeps the connection usable after rejecting an unread body", async () => {
    const { router } = makeRouter();
    const server = createServer(toNodeHandler(router, { createContext }));
    await new Promise<void>((r) => server.listen(0, r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const rejected = await fetch(base + "/rpc/add", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "x".repeat(200_000),
      });
      expect(rejected.status).toBe(415);
      const api = createClient<typeof router>(base);
      expect(await api.add({ a: 1, b: 2 })).toBe(3);
    } finally {
      server.close();
    }
  });
});
