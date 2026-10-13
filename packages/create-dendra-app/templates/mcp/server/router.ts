// One definition, many surfaces — plus AI. Each procedure is a typed client
// method and an RPC call; add `.ai({ description })` and it's ALSO a tool an LLM /
// Claude can call over MCP, executed with the same validation and ctx.

import { initDendra, s, type RouterRecord } from "dendra";
import type { Ctx, Note } from "./context";

const { route } = initDendra<Ctx>();

export const appRouter = {
  add: route
    .input(s.object({ a: s.number(), b: s.number() }))
    .ai({ description: "Add two numbers" })
    .handler(({ input }) => input.a + input.b),

  notes: {
    list: route
      .ai({ description: "List all notes" })
      .handler(({ ctx }): Note[] => ctx.db.notes.all()),

    create: route
      .input(s.object({ title: s.string(), body: s.string() }))
      .ai({ description: "Create a note with a title and body" })
      .handler(({ input, ctx }): Note => ctx.db.notes.create(input)),

    // Streaming RPC: a live subscription. The client does
    // `for await (const list of api.notes.watch())` and re-renders on each push.
    // Pushes whenever a note is written — including by Claude over MCP (a separate
    // process). Streaming = an async generator; nothing else to wire up.
    watch: route.stream(async function* ({ ctx }): AsyncGenerator<Note[]> {
      yield* ctx.db.notes.watch(ctx.signal);
    }),
  },
} satisfies RouterRecord;

export type AppRouter = typeof appRouter;
