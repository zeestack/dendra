"use client";

// AI streaming via the same typed client — `for await` over a streaming
// procedure. Swap the router's `ai.chat` handler for a real LLM stream and this
// component is unchanged.

import { useState } from "react";
import { api } from "@/lib/api";

export function ChatClient() {
  const [prompt, setPrompt] = useState("");
  const [output, setOutput] = useState("");
  const [busy, setBusy] = useState(false);

  async function send() {
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
    <div style={{ maxWidth: 560, margin: "40px auto", fontFamily: "system-ui" }}>
      <h1>Chat</h1>
      <div style={{ display: "flex", gap: 8 }}>
        <input
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Say something…"
          style={{ flex: 1 }}
        />
        <button onClick={send} disabled={busy}>
          {busy ? "…" : "Send"}
        </button>
      </div>
      <p style={{ whiteSpace: "pre-wrap", marginTop: 16 }}>{output}</p>
    </div>
  );
}
