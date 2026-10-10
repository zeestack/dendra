// Next.js App Router adapter. Next route handlers receive a Web `Request` and
// return a Web `Response` — which is exactly what `toFetchHandler` already is.
// So "Next support" is a five-line shim, and Next stays a swappable adapter
// rather than a dependency baked into the core.
//
// Usage in a Next app — app/rpc/[...nexus]/route.ts:
//
//   import { appRouter } from "@/server/router";
//   import { toNextHandler } from "nexus-rpc";
//   export const { GET, POST } = toNextHandler(appRouter, {
//     createContext: (req) => ({ userId: getSession(req) }),
//   });

import type { ServerOptions } from "./server.ts";
import { toFetchHandler } from "./server.ts";

export function toNextHandler<Ctx>(
  router: object,
  opts: ServerOptions<Ctx> = {},
): Record<
  "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  (req: Request) => Promise<Response>
> {
  const handler = toFetchHandler(router, opts);
  return {
    GET: handler,
    POST: handler,
    PUT: handler,
    PATCH: handler,
    DELETE: handler,
  };
}
