import { describe, it, expect } from "vitest";
import {
  initDendra,
  toFetchHandler,
  createClient,
  DendraClientError,
  s,
  type RouterRecord,
} from "../src/index.ts";

const { route } = initDendra();

const appRouter = {
  add: route
    .input(s.object({ a: s.number(), b: s.number() }))
    .handler(({ input }) => input.a + input.b),
  chat: route.input(s.object({ n: s.number() })).stream(async function* ({
    input,
  }) {
    for (let i = 0; i < input.n; i++) yield `t${i}`;
  }),
} satisfies RouterRecord;
type App = typeof appRouter;

// Wire the client's fetch straight into the server handler — full round-trip,
// request serialization and NDJSON streaming included, with no network.
const handler = toFetchHandler(appRouter);
const fetchImpl = ((input: string | URL | Request, init?: RequestInit) =>
  handler(
    new Request(typeof input === "string" ? input : input.toString(), init),
  )) as typeof fetch;

const client = createClient<App>("http://local", { fetch: fetchImpl });

describe("HTTP transport (client <-> server)", () => {
  it("unary round-trip", async () => {
    expect(await client.add({ a: 40, b: 2 })).toBe(42);
  });

  it("surfaces validation errors as DendraClientError", async () => {
    await expect(
      client.add({ a: 1, b: "no" as unknown as number }),
    ).rejects.toBeInstanceOf(DendraClientError);
  });

  it("streams NDJSON", async () => {
    const out: string[] = [];
    for await (const t of client.chat({ n: 3 })) out.push(t);
    expect(out).toEqual(["t0", "t1", "t2"]);
  });
});
