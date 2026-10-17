import { describe, it, expect } from "vitest";
import { initDendra, toFetchHandler, createClient, urlFor, file, s, type RouterRecord } from "../src/index.ts";

const { route } = initDendra();
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const router = {
  covers: {
    get: route
      .get()
      .input(s.object({ workspaceId: s.integer(), draftId: s.integer() }))
      .handler(() => file(PNG, { type: "image/png", inline: true })),
    upload: route.input(s.object({ id: s.integer() })).handler(() => "ok"),
  },
  url: route.handler(() => "a procedure named url"),
} satisfies RouterRecord;

const handler = toFetchHandler(router);
const fetchImpl = ((i: string | URL | Request, init?: RequestInit) =>
  handler(new Request(typeof i === "string" ? i : i.toString(), init))) as typeof fetch;
const api = createClient<typeof router>("http://local", { fetch: fetchImpl });

describe("urlFor", () => {
  it("builds a GET URL with the input as JSON in $input", () => {
    expect(urlFor(api.covers.get, { workspaceId: 3, draftId: 9 })).toBe(
      "http://local/rpc/covers.get?$input=" +
        encodeURIComponent(JSON.stringify({ workspaceId: 3, draftId: 9 })),
    );
  });

  it("the URL works, with typed (non-string) input", async () => {
    const res = await handler(new Request(urlFor(api.covers.get, { workspaceId: 3, draftId: 9 })));
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
  });

  it("a router key named url still works", async () => {
    expect(await api.url()).toBe("a procedure named url");
  });

  it("malformed $input is a 400", async () => {
    const res = await handler(new Request("http://local/rpc/covers.get?$input=%7Bnope"));
    expect(res.status).toBe(400);
  });

  it("throws for anything that isn't a client procedure", () => {
    expect(() => urlFor((() => Promise.resolve(1)) as never, {})).toThrow(
      "urlFor expects a procedure from createClient",
    );
  });
});
