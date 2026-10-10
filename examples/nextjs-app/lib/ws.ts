// WebSocket client for Tier-2 real-time (low-latency, bidirectional). It connects
// to the STANDALONE WS server (see ws-server.ts) because Next's serverless runtime
// can't host a long-lived socket — but it uses the SAME AppRouter type, so calls
// stay fully typed. A tiny buffer queues sends until the socket is open.

"use client";

import { connectWs, type WhatwgSocket } from "dendra";
import type { AppRouter } from "@/server/router";

let cached: ReturnType<typeof connectWs<AppRouter>> | null = null;

export function wsApi() {
  if (cached) return cached;
  const url = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:4000";
  const socket = new WebSocket(url);

  // Buffer sends until the connection is open.
  const buffer: string[] = [];
  let open = false;
  socket.addEventListener("open", () => {
    open = true;
    for (const m of buffer.splice(0)) socket.send(m);
  });

  const bufferedSocket: WhatwgSocket = {
    send: (data) => (open ? socket.send(data) : void buffer.push(data)),
    addEventListener: (event, cb) =>
      socket.addEventListener(event, cb as EventListener),
  };

  cached = connectWs<AppRouter>(bufferedSocket);
  return cached;
}
