// The single source of truth. Each procedure is a typed client method here; give
// it a path (.get/.post) and mount the REST adapter to also serve REST + OpenAPI,
// and add `.ai({ description })` to expose it as an LLM / MCP tool. This minimal
// starter wires up RPC + the typed client; see the `mcp` template for AI/MCP.

import { initDendra, s, type RouterRecord } from "dendra";
import type { Ctx, Note } from "./context";

const { route } = initDendra<Ctx>();

export const appRouter = {
  add: route
    .input(s.object({ a: s.number(), b: s.number() }))
    .handler(({ input }) => input.a + input.b),

  notes: {
    list: route.handler(({ ctx }): Note[] => ctx.db.notes.all()),
    create: route
      .input(s.object({ title: s.string(), body: s.string() }))
      .handler(({ input, ctx }): Note => ctx.db.notes.create(input)),
  },
} satisfies RouterRecord;

export type AppRouter = typeof appRouter;
