// Exposes the LLM toolset derived from the router (the `.ai()`-opted procedures),
// so the demo page can show what an AI model would receive.

import { toToolset } from "dendra";
import { appRouter } from "@/server/router";

export function GET() {
  return Response.json(toToolset(appRouter, { format: "anthropic" }));
}

export const runtime = "nodejs";
