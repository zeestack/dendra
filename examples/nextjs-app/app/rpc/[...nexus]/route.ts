// RPC mount — the typed client (lib/api.ts) talks to this.
// Catch-all so every procedure path resolves here: /rpc/notes.list, /rpc/ai.chat, …

import { toNextHandler } from "nexus-rpc";
import { appRouter } from "@/server/router";
import { createContext } from "@/server/context";

export const { GET, POST } = toNextHandler(appRouter, {
  prefix: "/rpc/",
  createContext,
});

// Streaming (ai.chat, notes.watch) needs the Node.js runtime, not edge, and must
// be dynamic so responses aren't cached.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
