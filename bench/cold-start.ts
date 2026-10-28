// One cold start, run in a fresh process by run.ts: load the server, build it,
// answer the first request. `bare` does the same without dendra, so the
// difference is what dendra adds to a cold start (a serverless boot).

const mode = process.argv[2];

let handler: (req: Request) => Promise<Response>;
if (mode === "dendra") {
  const { initDendra, s, toFetchHandler } = await import("../dist/index.js");
  const { route } = initDendra();
  handler = toFetchHandler({
    add: route
      .input(s.object({ a: s.number(), b: s.number() }))
      .handler(({ input }) => input.a + input.b),
  });
} else {
  handler = async (req) => {
    const input = JSON.parse(await req.text());
    return Response.json({ result: input.a + input.b });
  };
}

const res = await handler(
  new Request("http://localhost/rpc/add", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ a: 1, b: 2 }),
  }),
);
const body = (await res.json()) as { result?: number };
if (body.result !== 3) throw new Error(`unexpected response: ${JSON.stringify(body)}`);
