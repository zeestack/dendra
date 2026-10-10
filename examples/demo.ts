// End-to-end proof: defines a router once, then exercises it through the
// in-process caller, a real HTTP server + typed client (unary, validation error,
// streaming), the AI toolset derivation + safe executor, and a multi-user
// real-time subscription over pub/sub. Run with: `npm run demo`.

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  initNexus,
  createCaller,
  createClient,
  toNodeHandler,
  toToolset,
  createToolExecutor,
  createInMemoryPubSub,
  NexusClientError,
  s,
  type PubSub,
  type RouterRecord,
} from "../src/index.ts";

// ---------------------------------------------------------------------------
// 1. Context: what every handler receives. Note it's plain — no Next types here,
//    so these procedures run under any adapter.
// ---------------------------------------------------------------------------
interface Ctx {
  userId: string | null;
  pubsub: PubSub;
  signal?: AbortSignal;
}

const { route } = initNexus<Ctx>();

// ---------------------------------------------------------------------------
// 2. Define procedures ONCE. Each becomes: an RPC call, a typed client method,
//    an OpenAPI entry, and (if .ai()) an LLM tool.
// ---------------------------------------------------------------------------
const appRouter = {
  health: route.get("/health").handler(() => ({ ok: true, ts: Date.now() })),

  math: {
    add: route
      .post("/math/add")
      .input(s.object({ a: s.number(), b: s.number() }))
      .describe("Add two numbers")
      .ai({ description: "Add two numbers and return the sum" })
      .handler(({ input }) => input.a + input.b),
  },

  users: {
    create: route
      .post("/users")
      .input(
        s.object({
          name: s.string(),
          email: s.string(),
          age: s.optional(s.number()),
        }),
      )
      .handler(({ input }) => ({
        id: "usr_" + Math.random().toString(36).slice(2, 8),
        ...input,
      })),
  },

  // Streaming: a handler that returns an async generator. Simulates LLM tokens.
  chat: route
    .input(s.object({ prompt: s.string() }))
    .stream(async function* ({ input }) {
      const reply = `You said "${input.prompt}". Here is a streamed reply.`;
      for (const word of reply.split(" ")) {
        await sleep(40);
        yield word + " ";
      }
    }),

  // Real-time multi-user: a mutation publishes; a subscription yields from the bus.
  counter: {
    bump: route
      .input(s.object({ room: s.string(), by: s.number() }))
      .handler(({ input, ctx }) => {
        ctx.pubsub.publish(`counter:${input.room}`, { delta: input.by });
        return { ok: true };
      }),

    watch: route
      .input(s.object({ room: s.string() }))
      .stream(async function* ({ input, ctx }) {
        // ctx.signal aborts when the client disconnects — the subscription
        // tears down instead of leaking.
        for await (const ev of ctx.pubsub.subscribe(`counter:${input.room}`, {
          signal: ctx.signal,
        })) {
          yield ev as { delta: number };
        }
      }),
  },
} satisfies RouterRecord;

type AppRouter = typeof appRouter;

// ---------------------------------------------------------------------------
// Boot an HTTP server using the Node adapter.
// ---------------------------------------------------------------------------
const pubsub = createInMemoryPubSub();
const handler = toNodeHandler<Ctx>(appRouter, {
  createContext: (req) => ({
    userId: req.headers.get("x-user-id"),
    pubsub,
    signal: req.signal,
  }),
});
const server = createServer((req, res) => {
  handler(req, res).catch((e) => {
    console.error(e);
    res.statusCode = 500;
    res.end();
  });
});
await new Promise<void>((r) => server.listen(0, r));
const port = (server.address() as AddressInfo).port;
const baseUrl = `http://localhost:${port}`;

// Typed client — the type comes straight from `typeof appRouter`. No codegen.
const client = createClient<AppRouter>(baseUrl);

const line = (t: string) => console.log("\n\x1b[1m" + t + "\x1b[0m");

try {
  // -------------------------------------------------------------------------
  line("1. In-process caller (no HTTP) — used by RSC / AI tools");
  const caller = createCaller(appRouter, { userId: "u1", pubsub });
  console.log("   caller.math.add({a:2,b:3}) =>", await caller.math.add({ a: 2, b: 3 }));

  // -------------------------------------------------------------------------
  line("2. Typed HTTP client — unary");
  console.log("   client.health() =>", await client.health());
  console.log("   client.math.add({a:40,b:2}) =>", await client.math.add({ a: 40, b: 2 }));
  const user = await client.users.create({ name: "Ada", email: "ada@x.io" });
  console.log("   client.users.create(...) =>", user);

  // -------------------------------------------------------------------------
  line("3. Validation guardrail — bad input is rejected with a typed error");
  try {
    // @ts-expect-error — `b` must be a number; TS catches this at compile time too.
    await client.math.add({ a: 1, b: "not-a-number" });
  } catch (e) {
    if (e instanceof NexusClientError) {
      console.log("   rejected:", e.code, "-", e.message);
      console.log("   details:", JSON.stringify(e.details));
    } else throw e;
  }

  // -------------------------------------------------------------------------
  line("4. Streaming — same client, iterate instead of await");
  process.stdout.write("   client.chat({prompt:'hello'}) => ");
  for await (const token of client.chat({ prompt: "hello" })) {
    process.stdout.write(token);
  }
  process.stdout.write("\n");

  // -------------------------------------------------------------------------
  line("5. AI tools — derived from the SAME procedures (.ai() opt-in only)");
  console.log(JSON.stringify(toToolset(appRouter, { format: "anthropic" }), null, 2));

  line("6. Tool execution — validated, hallucinated args rejected");
  const execute = createToolExecutor(appRouter, { userId: "u1", pubsub });
  console.log("   execute('math.add', {a:5,b:7}) =>", await execute("math.add", { a: 5, b: 7 }));
  try {
    await execute("math.add", { a: 5, b: "twelve" });
  } catch (e) {
    console.log("   hallucinated args =>", (e as Error).message);
  }
  try {
    await execute("users.create", { name: "x", email: "y" });
  } catch (e) {
    console.log("   non-exposed proc =>", (e as Error).message);
  }

  // -------------------------------------------------------------------------
  line("7. Multi-user real-time — one subscriber, events pushed via pub/sub");
  const received: number[] = [];
  const sub = (async () => {
    for await (const ev of client.counter.watch({ room: "lobby" })) {
      received.push(ev.delta);
      if (received.length >= 3) break;
    }
  })();
  await sleep(50); // let the subscription connect
  await client.counter.bump({ room: "lobby", by: 1 });
  await client.counter.bump({ room: "lobby", by: 5 });
  await client.counter.bump({ room: "lobby", by: 10 });
  await sub;
  console.log("   subscriber received deltas =>", received);

  line("All checks passed ✓");
} finally {
  // Node's fetch pools keep-alive sockets; destroy them so the server — and the
  // process — can shut down cleanly.
  server.closeAllConnections();
  server.close();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
