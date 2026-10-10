// Serves the OpenAPI 3.1 document at /openapi.json — point Swagger UI at it, or
// generate clients with `npx openapi-typescript http://localhost:3000/openapi.json`.

import { toOpenApiDocument } from "nexus-rpc";
import { appRouter } from "@/server/router";

export function GET() {
  const doc = toOpenApiDocument(appRouter, {
    info: { title: "Notes API", version: "1.0.0" },
    servers: [{ url: "/api" }],
  });
  return Response.json(doc);
}
