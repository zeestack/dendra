// The calls the runtime benchmarks make, each served two ways: by dendra (the
// built package, as users install it) and by a bare fetch handler that does the
// same work by hand. The bare handler is the yardstick — dendra is scored by how
// much slower it is than that, not in ops/s, so the gate holds on any machine.

import { initDendra, s, toFetchHandler, type RouterRecord } from "../dist/index.js";

const { route } = initDendra();

const router = {
  add: route
    .input(s.object({ a: s.number(), b: s.number() }))
    .handler(({ input }) => input.a + input.b),
  item: route
    .get()
    .input(s.object({ id: s.string() }))
    .handler(({ input }) => ({ id: input.id, title: `Item ${input.id}` })),
  ticks: route
    .input(s.object({ n: s.integer() }))
    .stream(async function* ({ input }) {
      for (let i = 0; i < input.n; i++) yield { i };
    }),
} satisfies RouterRecord;

export const dendraHandler = toFetchHandler(router, { prefix: "/rpc/" });

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const isNumber = (v: unknown) => typeof v === "number";

// What a careful hand-written handler does for the same three calls: route,
// parse, validate, respond with the same wire format.
export async function bareHandler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  switch (url.pathname) {
    case "/rpc/add": {
      if (req.method !== "POST") return json({ error: { code: "METHOD_NOT_ALLOWED" } }, 405);
      const input = JSON.parse(await req.text());
      if (!input || !isNumber(input.a) || !isNumber(input.b)) {
        return json({ error: { code: "BAD_REQUEST" } }, 400);
      }
      return json({ result: input.a + input.b });
    }
    case "/rpc/item": {
      const id = url.searchParams.get("id");
      if (id === null) return json({ error: { code: "BAD_REQUEST" } }, 400);
      return json({ result: { id, title: `Item ${id}` } });
    }
    case "/rpc/ticks": {
      const input = JSON.parse(await req.text());
      if (!input || !Number.isInteger(input.n)) return json({ error: { code: "BAD_REQUEST" } }, 400);
      const encoder = new TextEncoder();
      let i = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (i < input.n) controller.enqueue(encoder.encode(JSON.stringify({ i: i++ }) + "\n"));
          else controller.close();
        },
      });
      return new Response(body, { headers: { "content-type": "application/x-ndjson" } });
    }
    default:
      return json({ error: { code: "NOT_FOUND" } }, 404);
  }
}

export interface Scenario {
  name: string;
  request: () => Request;
}

const post = (path: string, body: unknown) => () =>
  new Request(`http://localhost/rpc/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/x-ndjson" },
    body: JSON.stringify(body),
  });

export const scenarios: Scenario[] = [
  { name: "unary", request: post("add", { a: 1, b: 2 }) },
  { name: "get", request: () => new Request("http://localhost/rpc/item?id=42") },
  { name: "stream", request: post("ticks", { n: 20 }) },
];

// Every call reads the whole body, so streams are timed to their last frame.
export async function call(handler: (req: Request) => Promise<Response>, scenario: Scenario) {
  const res = await handler(scenario.request());
  if (!res.ok) throw new Error(`${scenario.name}: HTTP ${res.status} ${await res.text()}`);
  await res.arrayBuffer();
}
