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

export default async function Page() {
  const host = headers().get("host") ?? "";
  const tenantId = tenantFromHost(host);

  const caller = createCaller(appRouter, directContext("u_123", tenantId));
  const notes = await caller.notes.list(); // typed as Note[], scoped to tenant

  return (
    <main style={{ maxWidth: 560, margin: "40px auto", fontFamily: "system-ui" }}>
      <h1>Notes</h1>
      <p style={{ color: "#666" }}>
        Tenant: <strong>{tenantId}</strong> · server-rendered via{" "}
        <code>createCaller</code>; live updates via a subscription.
      </p>
      <p>
        → <a href="/demo">Interactive feature demo</a> ·{" "}
        <a href="/chat">AI streaming chat</a> ·{" "}
        <a href="/assistant">Generative-UI assistant</a>
      </p>
      <NotesClient initial={notes} />
    </main>
  );
}
