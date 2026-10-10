"use client";

// Generative-UI chat. The assistant streams typed PARTS; text renders as text,
// and each tool part renders a real React component chosen from the registry
// below. Try: "show my notes" → renders a NoteList; "create a note titled
// Groceries with body milk, eggs" → renders a NoteCard.

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import type { ChatPart } from "@/lib/chat-types";
import type { Note } from "@/server/db";

type ToolPart = Extract<ChatPart, { type: "tool" }>;
type Item =
  | { role: "user"; text: string }
  | { role: "assistant"; parts: ChatPart[] };

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
};

export default function AssistantPage() {
  const [items, setItems] = useState<Item[]>([]);
  const [input, setInput] = useState("show my notes");
  const [busy, setBusy] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [items]);

  async function send() {
    const prompt = input.trim();
    if (!prompt || busy) return;
    setInput("");
    setBusy(true);
    setItems((c) => [
      ...c,
      { role: "user", text: prompt },
      { role: "assistant", parts: [] },
    ]);
    try {
      for await (const part of api.ai.assistant({ prompt })) {
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
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={S.page}>
      <h1>Assistant</h1>
      <p style={S.sub}>
        The model calls tools; each tool result renders a real component. Try
        “show my notes” or “create a note titled Groceries with body milk, eggs”.
      </p>

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
        <button style={S.btn} onClick={send} disabled={busy}>
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
  inputRow: { display: "flex", gap: 8, position: "sticky", bottom: 16 },
  input: { flex: 1, padding: "10px 12px", borderRadius: 8, border: "1px solid #ccc" },
  btn: { padding: "10px 16px", borderRadius: 8, border: "1px solid #ccc", background: "#fafafa", cursor: "pointer" },
};
