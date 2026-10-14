"use client";

// One page that exercises every dendra feature against the live Next app.
// Each card runs a real call and shows the result. The "Real-time feed" stays
// subscribed, so creating a note (card 1) makes it appear there live.

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { wsApi } from "@/lib/ws";
import type { Note } from "@/server/db";
import u from "../ui.module.css";

export default function DemoPage() {
  return (
    <main className={u.page}>
      <div className={u.hero}>
        <h1 className={u.h1}>Feature demo</h1>
        <p className={u.lead}>
          Every card calls the live router. Open your network tab to watch the
          actual requests.
        </p>
      </div>
      <UnaryRpc />
      <RestCard />
      <ValidationCard />
      <StreamingCard />
      <RealtimeCard />
      <AiToolsCard />
      <OpenApiCard />
      <WebSocketCard />
    </main>
  );
}

// 1 ── Unary RPC + 2 ── Query ------------------------------------------------
function UnaryRpc() {
  const [out, setOut] = useState("—");
  const [list, setList] = useState("—");
  return (
    <Card title="1 · Unary RPC (typed client → /rpc/…)">
      <Row>
        <button
          className={u.btn}
          onClick={async () => {
            const note = await api.notes.create({
              title: "Note " + new Date().toLocaleTimeString(),
              body: "created via api.notes.create()",
            });
            setOut(JSON.stringify(note, null, 2));
          }}
        >
          api.notes.create(…)
        </button>
        <button
          className={u.btn}
          onClick={async () => setList(JSON.stringify(await api.notes.list(), null, 2))}
        >
          api.notes.list()
        </button>
      </Row>
      <Pre>{out}</Pre>
      <Pre>{list}</Pre>
    </Card>
  );
}

// 3 ── REST front-end --------------------------------------------------------
function RestCard() {
  const [out, setOut] = useState("—");
  return (
    <Card title="3 · REST front-end (same router → GET /api/notes)">
      <button
        className={u.btn}
        onClick={async () => {
          const res = await fetch("/api/notes");
          setOut(`HTTP ${res.status}\n` + JSON.stringify(await res.json(), null, 2));
        }}
      >
        fetch("/api/notes")
      </button>
      <Pre>{out}</Pre>
    </Card>
  );
}

// 4 ── Validation guardrail --------------------------------------------------
function ValidationCard() {
  const [out, setOut] = useState("—");
  return (
    <Card title="4 · Validation guardrail (bad input → 400 with details)">
      <button
        className={u.btn}
        onClick={async () => {
          // Raw fetch so we can send an intentionally invalid body.
          const res = await fetch("/rpc/notes.create", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ title: 123 }), // wrong types, missing body
          });
          setOut(`HTTP ${res.status}\n` + JSON.stringify(await res.json(), null, 2));
        }}
      >
        send invalid note
      </button>
      <Pre>{out}</Pre>
    </Card>
  );
}

// 5 ── Streaming -------------------------------------------------------------
function StreamingCard() {
  const [prompt, setPrompt] = useState("hello streaming");
  const [out, setOut] = useState("—");
  const [busy, setBusy] = useState(false);
  return (
    <Card title="5 · Streaming (for await over api.ai.chat())">
      <Row>
        <input className={u.input} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
        <button
          className={u.btn}
          disabled={busy}
          onClick={async () => {
            setOut("");
            setBusy(true);
            try {
              for await (const token of api.ai.chat({ prompt })) {
                setOut((o) => o + token);
              }
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "streaming…" : "stream"}
        </button>
      </Row>
      <Pre>{out}</Pre>
    </Card>
  );
}

// 6 ── Real-time subscription ------------------------------------------------
function RealtimeCard() {
  const [feed, setFeed] = useState<Note[]>([]);
  const [status, setStatus] = useState("connecting…");
  useEffect(() => {
    let active = true;
    (async () => {
      setStatus("subscribed — create a note in card 1 to see it appear");
      try {
        for await (const ev of api.notes.watch()) {
          if (!active) break;
          if (ev.type === "created") setFeed((f) => [ev.note, ...f].slice(0, 8));
        }
      } catch {
        if (active) setStatus("subscription ended");
      }
    })();
    // Cleanup breaks the loop; the client cancels the stream. Under React dev
    // StrictMode this remounts cleanly and leaves exactly one live subscription.
    return () => {
      active = false;
    };
  }, []);
  return (
    <Card title="6 · Real-time subscription (api.notes.watch() over HTTP stream)">
      <p className={u.note}>{status}</p>
      <Pre>
        {feed.length
          ? feed.map((n) => `• ${n.title} — ${n.body}`).join("\n")
          : "(no events yet)"}
      </Pre>
    </Card>
  );
}

// 7 ── AI tools --------------------------------------------------------------
function AiToolsCard() {
  const [tools, setTools] = useState("—");
  const [exec, setExec] = useState("—");
  return (
    <Card title="7 · AI tools (derived from .ai() procedures)">
      <Row>
        <button
          className={u.btn}
          onClick={async () => {
            const res = await fetch("/tools");
            setTools(JSON.stringify(await res.json(), null, 2));
          }}
        >
          GET /tools (toolset)
        </button>
        <button
          className={u.btn}
          onClick={async () => {
            // ai.summarize is the exposed tool — calling it via the client is the
            // same code path the tool executor uses server-side.
            const r = await api.ai.summarize({
              text: "dendra turns one procedure definition into RPC, REST, OpenAPI, a typed client, and an LLM tool.",
            });
            setExec(JSON.stringify(r, null, 2));
          }}
        >
          run ai.summarize
        </button>
      </Row>
      <Pre>{tools}</Pre>
      <Pre>{exec}</Pre>
    </Card>
  );
}

// 8 ── OpenAPI ---------------------------------------------------------------
function OpenApiCard() {
  const [out, setOut] = useState("—");
  return (
    <Card title="8 · OpenAPI 3.1 (auto-derived)">
      <Row>
        <button
          className={u.btn}
          onClick={async () => {
            const res = await fetch("/openapi.json");
            setOut(JSON.stringify(await res.json(), null, 2));
          }}
        >
          GET /openapi.json
        </button>
        <a className={u.link} href="/openapi.json" target="_blank" rel="noreferrer">
          open raw ↗
        </a>
      </Row>
      <Pre>{out}</Pre>
    </Card>
  );
}

// 9 ── WebSocket -------------------------------------------------------------
function WebSocketCard() {
  const [out, setOut] = useState("—");
  return (
    <Card title="9 · WebSocket transport (needs `npm run ws` in another terminal)">
      <button
        className={u.btn}
        onClick={async () => {
          try {
            const r = await wsApi().notes.list();
            setOut("over WS → " + JSON.stringify(r, null, 2));
          } catch (e) {
            setOut(
              "WS not reachable — start it with `npm run ws`.\n" +
                (e as Error).message,
            );
          }
        }}
      >
        call notes.list() over WebSocket
      </button>
      <Pre>{out}</Pre>
    </Card>
  );
}

// ── tiny UI helpers ---------------------------------------------------------
function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className={u.card}>
      <h3 className={u.cardTitle}>{title}</h3>
      {children}
    </section>
  );
}
function Row({ children }: { children: React.ReactNode }) {
  return <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>{children}</div>;
}
function Pre({ children }: { children: React.ReactNode }) {
  return <pre className={u.pre}>{children}</pre>;
}
