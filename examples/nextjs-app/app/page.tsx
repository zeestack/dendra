// Server Component. Loads initial data by calling the router IN-PROCESS via
// createCaller — no HTTP round-trip, no serialization — then hands off to a
// Client Component for interactivity.
//
// Tenant is resolved from the request host (next/headers) and passed into the
// in-process context, so the server render is tenant-scoped just like the HTTP
// adapters. Visit acme.localhost:3100 vs beta.localhost:3100 to see isolation.

import { headers } from "next/headers";
import { createCaller } from "dendra";
import { appRouter } from "@/server/router";
import { directContext, tenantFromHost } from "@/server/context";
import { NotesClient } from "./notes-client";
import { Digest } from "./digest";
import u from "./ui.module.css";

export default async function Page() {
  const host = headers().get("host") ?? "";
  const tenantId = tenantFromHost(host);

  const caller = createCaller(appRouter, directContext("u_123", tenantId));
  const notes = await caller.notes.list(); // typed as Note[], scoped to tenant

  return (
    <main className={u.page}>
      <div className={u.hero}>
        <span className={u.badge}>tenant: {tenantId}</span>
        <h1 className={u.h1} style={{ marginTop: 12 }}>
          Notes
        </h1>
        <p className={u.lead}>
          Server-rendered in-process with <span className={u.mono}>createCaller</span>{" "}
          (no HTTP round-trip), then kept live by a <span className={u.mono}>notes.watch</span>{" "}
          subscription — the same typed client, awaited for unary and{" "}
          <span className={u.mono}>for await</span>-ed for streaming.
        </p>
      </div>
      <NotesClient initial={notes} />
      <Digest />
    </main>
  );
}
