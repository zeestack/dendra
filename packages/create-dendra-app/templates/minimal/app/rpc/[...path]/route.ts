// RPC mount — the typed client (lib/api.ts) talks to this. Catch-all so every
// procedure resolves here: /rpc/add, /rpc/notes.list, /rpc/notes.create, …
import { toNextHandler } from "dendra";
import { appRouter } from "@/server/router";
import { createContext } from "@/server/context";

export const { GET, POST } = toNextHandler(appRouter, {
  prefix: "/rpc/",
  createContext,
});

// Streaming procedures need the Node runtime, and responses shouldn't be cached.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
