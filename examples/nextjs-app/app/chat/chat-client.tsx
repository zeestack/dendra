"use client";

// AI streaming via the same typed client — `for await` over a streaming
// procedure. Swap the router's `ai.chat` handler for a real LLM stream and this
// component is unchanged.

import { useState } from "react";
import { api } from "@/lib/api";
import u from "../ui.module.css";

export function ChatClient() {
  const [prompt, setPrompt] = useState("");
  const [output, setOutput] = useState("");
  const [busy, setBusy] = useState(false);

  async function send() {
    if (!prompt.trim() || busy) return;
    setOutput("");
    setBusy(true);
    try {
      for await (const token of api.ai.chat({ prompt })) {
        setOutput((o) => o + token);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className={u.page}>
      <div className={u.hero}>
        <h1 className={u.h1}>Streaming chat</h1>
        <p className={u.lead}>
          <span className={u.mono}>for await</span> over a streaming procedure —
          the same typed client, iterated instead of awaited.
        </p>
      </div>
      <div className={u.row}>
        <input
          className={u.input}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          placeholder="Say something…"
        />
        <button onClick={send} disabled={busy} className={`${u.btn} ${u.btnPrimary}`}>
          {busy ? "…" : "Send"}
        </button>
      </div>
      {(output || busy) && (
        <div className={u.card} style={{ whiteSpace: "pre-wrap", minHeight: 48 }}>
          {output || <span className={u.muted}>…</span>}
        </div>
      )}
    </main>
  );
}
