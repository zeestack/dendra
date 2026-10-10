// REST mount — resource-style URLs (GET /api/notes, POST /api/notes) for external
// consumers, webhooks, and anything that reads the OpenAPI spec. Same router,
// same validation, different doorway.

import { toRestHandler } from "nexus-rpc";
import { appRouter } from "@/server/router";
import { createContext } from "@/server/context";

const handler = toRestHandler(appRouter, {
  prefix: "/api",
  createContext,
});

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
