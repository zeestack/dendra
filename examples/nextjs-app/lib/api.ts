// The browser client. Its type comes entirely from `typeof appRouter` — no
// generated files, no build step. Same-origin, so baseUrl is "".
//
// BYOK: `headers` is a mutable object the client spreads at REQUEST time, so
// mutating it changes the header sent on later calls without recreating the
// client. We use it to carry an optional user-supplied Anthropic key.

import { createClient } from "dendra";
import type { AppRouter } from "@/server/router";

const KEY_STORAGE = "dendra-anthropic-key";
const headers: Record<string, string> = {};

// Streams use Server-Sent Events, which proxies and CDNs pass through
// unbuffered more reliably than NDJSON.
export const api = createClient<AppRouter>("", { prefix: "/rpc/", headers, streamFormat: "sse" });

/** Set (or clear) the user's Anthropic key — kept in this browser only. */
export function setAnthropicKey(key: string | null): void {
  const k = key?.trim();
  if (k) {
    headers["x-anthropic-key"] = k;
    try {
      localStorage.setItem(KEY_STORAGE, k);
    } catch {
      /* storage blocked — key just won't persist across reloads */
    }
  } else {
    delete headers["x-anthropic-key"];
    try {
      localStorage.removeItem(KEY_STORAGE);
    } catch {
      /* ignore */
    }
  }
}

export function getAnthropicKey(): string {
  return headers["x-anthropic-key"] ?? "";
}

// Restore a saved key on load (browser only).
if (typeof window !== "undefined") {
  try {
    const saved = localStorage.getItem(KEY_STORAGE);
    if (saved) headers["x-anthropic-key"] = saved;
  } catch {
    /* ignore */
  }
}
