"use client";

// Generative-UI chat. The assistant streams typed PARTS; text renders as text,
// and each tool part renders a real React component chosen from the registry
// below. Try: "show my notes" → renders a NoteList; "create a note titled
// Groceries with body milk, eggs" → renders a NoteCard.

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import type { ChatPart } from "@/lib/chat-types";
import type { Note } from "@/server/db";

type ToolPart = Extract<ChatPart, { type: "tool" }>;
type Item =
  | { role: "user"; text: string }
  | { role: "assistant"; parts: ChatPart[] };
type McpInfo = {
  connected: boolean;
  server: string;
  transport: string;
  tools: Array<{ name: string; description: string }>;
};

// ── The registry: tool name → component ────────────────────────────────────
const REGISTRY: Record<string, React.FC<{ part: ToolPart }>> = {
  "notes.list": ({ part }) => <NoteList notes={(part.result as Note[]) ?? []} />,
  "notes.create": ({ part }) => <NoteCard note={part.result as Note} />,
  "notes.delete": ({ part }) => (
    <div style={{ ...S.card, borderColor: "#c62828" }}>
      <div style={{ ...S.cardLabel, color: "#c62828" }}>🗑 Note deleted</div>
      <code style={S.id}>{(part.result as { id: string }).id}</code>
    </div>
  ),
  "ai.summarize": ({ part }) => (
    <SummaryCard summary={(part.result as { summary: string }).summary} />
  ),
  "ui.navigate": ({ part }) => (
    <div style={S.card}>
      <div style={S.cardLabel}>➡️ Navigating</div>
      <code>{(part.result as { to: string }).to}</code>
    </div>
  ),
  // External tools, served by a separate MCP server and merged into the toolset.
  "ext.weather.get": ({ part }) => {
    const r = part.result as { city: string; condition: string; tempC: number };
    return (
      <div style={{ ...S.card, borderColor: "#6d28d9" }}>
        <div style={{ ...S.cardLabel, color: "#6d28d9" }}>
          🔌 via MCP · weather
        </div>
        <strong>{r.city}</strong>: {r.condition}, {r.tempC}°C
      </div>
    );
  },
  "ext.time.now": ({ part }) => (
    <div style={{ ...S.card, borderColor: "#6d28d9" }}>
      <div style={{ ...S.cardLabel, color: "#6d28d9" }}>🔌 via MCP · time</div>
      <code>{(part.result as { now: string }).now}</code>
    </div>
  ),
};

export default function AssistantPage() {
  const router = useRouter();
  const [items, setItems] = useState<Item[]>([]);
  const [input, setInput] = useState("show my notes");
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [mcp, setMcp] = useState<McpInfo | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  // Only touch browser-only APIs after mount so SSR and the first client render
  // agree (avoids a hydration mismatch on the voice button).
  useEffect(() => setMounted(true), []);

  // Which external MCP server is wired into the toolset (shown at the top).
  useEffect(() => {
    api.mcp.external().then(setMcp).catch(() => setMcp(null));
  }, []);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [items]);

  async function send(override?: string) {
    const prompt = (override ?? input).trim();
    if (!prompt || busy) return;
    setInput("");
    setBusy(true);
    setItems((c) => [
      ...c,
      { role: "user", text: prompt },
      { role: "assistant", parts: [] },
    ]);
    let spoken = ""; // accumulate the reply text to speak (TTS)
    try {
      for await (const part of api.ai.assistant({ prompt })) {
        if (part.type === "text") spoken += part.text;
        setItems((c) => {
          const copy = c.slice();
          const last = copy[copy.length - 1];
          if (last?.role !== "assistant") return c;
          const parts = last.parts.slice();
          const prev = parts[parts.length - 1];
          if (part.type === "text" && prev?.type === "text") {
            parts[parts.length - 1] = { type: "text", text: prev.text + part.text };
          } else {
            parts.push(part);
          }
          copy[copy.length - 1] = { role: "assistant", parts };
          return copy;
        });
        // ui.navigate is a client action: the server tool just returns the path;
        // the client performs the actual route change.
        if (part.type === "tool" && part.name === "ui.navigate") {
          const to = (part.result as { to?: string })?.to;
          if (to) router.push(to);
        }
      }
    } finally {
      setBusy(false);
      // Text-to-speech the reply (browser SpeechSynthesis — no deps, no server).
      const text = spoken.trim();
      if (text && typeof window !== "undefined" && "speechSynthesis" in window) {
        try {
          window.speechSynthesis.cancel();
          window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
        } catch {
          /* TTS unavailable — ignore */
        }
      }
    }
  }

  // --- Voice input (browser SpeechRecognition — Chrome/Edge, HTTPS/localhost) --
  const voiceSupported =
    mounted &&
    typeof window !== "undefined" &&
    ("SpeechRecognition" in window || "webkitSpeechRecognition" in window);

  function startListening() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Ctor = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
    if (!Ctor) return;
    const rec = new Ctor();
    rec.lang = "en-US";
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    setListening(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rec.onresult = (e: any) => {
      const transcript = String(e.results[0][0].transcript);
      setInput(transcript);
      void send(transcript); // STT → the same assistant pipeline
    };
    rec.onerror = () => setListening(false);
    rec.onend = () => setListening(false);
    rec.start();
  }

  return (
    <main style={S.page}>
      <h1>Assistant</h1>
      <p style={S.sub}>
        The model calls tools; each tool result renders a real component. Try
        “show my notes” or “create a note titled Groceries with body milk, eggs”.
      </p>

      {mcp && (
        <div style={S.mcpPanel}>
          <div style={S.mcpHead}>
            <span style={{ ...S.dot, background: mcp.connected ? "#16a34a" : "#999" }} />
            <strong style={{ fontSize: 13 }}>
              {mcp.connected ? "MCP server connected" : "No MCP server"}
            </strong>
            {mcp.connected && (
              <span style={S.mcpMeta}>
                {mcp.server} · {mcp.transport}
              </span>
            )}
          </div>
          {mcp.tools.length > 0 && (
            <div style={S.mcpTools}>
              {mcp.tools.map((t) => (
                <span key={t.name} style={S.mcpTool} title={t.description}>
                  🔌 {t.name}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      <div style={S.thread}>
        {items.map((it, i) =>
          it.role === "user" ? (
            <div key={i} style={S.user}>
              {it.text}
            </div>
          ) : (
            <div key={i} style={S.assistant}>
              {it.parts.length === 0 && <span style={S.dim}>…</span>}
              {it.parts.map((p, j) =>
                p.type === "text" ? (
                  <span key={j} style={{ whiteSpace: "pre-wrap" }}>
                    {p.text}
                  </span>
                ) : (
                  <div key={j} style={S.toolWrap}>
                    {(() => {
                      const Comp = REGISTRY[p.name] ?? GenericCard;
                      return <Comp part={p} />;
                    })()}
                  </div>
                ),
              )}
            </div>
          ),
        )}
        <div ref={bottom} />
      </div>

      <div style={S.inputRow}>
        <input
          style={S.input}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          placeholder="Ask the assistant…"
        />
        {voiceSupported && (
          <button
            style={{ ...S.btn, background: listening ? "#fde68a" : S.btn.background }}
            onClick={startListening}
            disabled={busy || listening}
            title="Speak your request"
          >
            {listening ? "🎙️…" : "🎤"}
          </button>
        )}
        <button style={S.btn} onClick={() => send()} disabled={busy}>
          {busy ? "…" : "Send"}
        </button>
      </div>
    </main>
  );
}

// ── Components rendered inside the chat ─────────────────────────────────────
function NoteList({ notes }: { notes: Note[] }) {
  if (!notes.length) return <div style={S.card}>No notes yet.</div>;
  return (
    <div style={S.card}>
      <div style={S.cardLabel}>📋 Notes ({notes.length})</div>
      {notes.map((n) => (
        <div key={n.id} style={S.noteRow}>
          <strong>{n.title}</strong>
          <span style={S.dim}> — {n.body}</span>
        </div>
      ))}
    </div>
  );
}

function NoteCard({ note }: { note: Note }) {
  return (
    <div style={{ ...S.card, borderColor: "#2e7d32" }}>
      <div style={{ ...S.cardLabel, color: "#2e7d32" }}>✓ Note created</div>
      <strong>{note.title}</strong>
      <div style={S.dim}>{note.body}</div>
      <code style={S.id}>{note.id}</code>
    </div>
  );
}

function SummaryCard({ summary }: { summary: string }) {
  return (
    <div style={S.card}>
      <div style={S.cardLabel}>📝 Summary</div>
      {summary}
    </div>
  );
}

function GenericCard({ part }: { part: ToolPart }) {
  return (
    <div style={{ ...S.card, borderColor: part.isError ? "#c62828" : "#ccc" }}>
      <div style={S.cardLabel}>{part.name}</div>
      <pre style={S.pre}>{JSON.stringify(part.result, null, 2)}</pre>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  page: { maxWidth: 640, margin: "40px auto", padding: "0 16px", fontFamily: "system-ui, sans-serif" },
  sub: { color: "#666", fontSize: 14 },
  thread: { display: "flex", flexDirection: "column", gap: 12, margin: "20px 0", minHeight: 200 },
  user: { alignSelf: "flex-end", background: "#2563eb", color: "white", padding: "8px 12px", borderRadius: 12, maxWidth: "80%" },
  assistant: { alignSelf: "flex-start", display: "flex", flexDirection: "column", gap: 8, maxWidth: "90%" },
  toolWrap: { margin: "2px 0" },
  card: { border: "1px solid #ccc", borderRadius: 10, padding: 12, background: "#fafafa", fontSize: 14 },
  cardLabel: { fontSize: 12, fontWeight: 600, color: "#555", marginBottom: 6 },
  noteRow: { padding: "2px 0" },
  id: { fontSize: 11, color: "#999", display: "block", marginTop: 4 },
  dim: { color: "#777" },
  pre: { margin: 0, fontSize: 12, whiteSpace: "pre-wrap" },
  mcpPanel: { border: "1px solid #ddd6fe", background: "#f5f3ff", borderRadius: 10, padding: "10px 12px", margin: "12px 0" },
  mcpHead: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
  mcpMeta: { fontSize: 12, color: "#6d28d9" },
  dot: { width: 8, height: 8, borderRadius: "50%", display: "inline-block" },
  mcpTools: { display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 },
  mcpTool: { fontSize: 12, color: "#5b21b6", background: "white", border: "1px solid #ddd6fe", borderRadius: 999, padding: "2px 10px", cursor: "default" },
  inputRow: { display: "flex", gap: 8, position: "sticky", bottom: 16 },
  input: { flex: 1, padding: "10px 12px", borderRadius: 8, border: "1px solid #ccc" },
  btn: { padding: "10px 16px", borderRadius: 8, border: "1px solid #ccc", background: "#fafafa", cursor: "pointer" },
};
