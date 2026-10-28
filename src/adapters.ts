// Next.js App Router adapter. Next route handlers receive a Web `Request` and
// return a Web `Response` — which is exactly what `toFetchHandler` already is.
// So "Next support" is a five-line shim, and Next stays a swappable adapter
// rather than a dependency baked into the core.
//
// Usage in a Next app — app/rpc/[...path]/route.ts:
//
//   import { appRouter } from "@/server/router";
//   import { toNextHandler } from "dendra";
//   export const { GET, POST } = toNextHandler(appRouter, {
//     createContext: (req) => ({ userId: getSession(req) }),
//   });

import type { ServerOptions } from "./server.ts";
import { toFetchHandler } from "./server.ts";

// Only GET and POST: the RPC protocol answers nothing else (a 405). For REST
// verbs over Next, export `toRestHandler(router, opts)` as each method instead.
export function toNextHandler<Ctx>(
  router: object,
  opts: ServerOptions<Ctx> = {},
): Record<"GET" | "POST", (req: Request) => Promise<Response>> {
  const handler = toFetchHandler(router, opts);
  return { GET: handler, POST: handler };
}
