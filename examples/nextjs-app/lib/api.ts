// The browser client. Its type comes entirely from `typeof appRouter` — no
// generated files, no build step. Same-origin, so baseUrl is "".

import { createClient } from "nexus-rpc";
import type { AppRouter } from "@/server/router";

export const api = createClient<AppRouter>("", { prefix: "/rpc/" });
