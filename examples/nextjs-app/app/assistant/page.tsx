"use client";

// Generative-UI chat. The assistant streams typed PARTS; text renders as text,
// and each tool part renders a real React component chosen from the registry
// below. Try: "show my notes" → renders a NoteList; "create a note titled
// Groceries with body milk, eggs" → renders a NoteCard.

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useAssistant } from "dendra/react";
import { api } from "@/lib/api";
import type { ChatPart } from "@/lib/chat-types";
import type { Note } from "@/server/db";

type ToolPart = Extract<ChatPart, { type: "tool" }>;
type McpServer = {
  id: string;
  server: string;
  transport: string;
  prefix: string;
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
  const [listening, setListening] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [servers, setServers] = useState<McpServer[]>([]);
  const [showConnect, setShowConnect] = useState(false);
  const [connUrl, setConnUrl] = useState("");
  const [connName, setConnName] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [connError, setConnError] = useState("");
  const [connNote, setConnNote] = useState("");
  const bottom = useRef<HTMLDivElement>(null);

  // The chat thread + streaming is the framework's useAssistant hook. The page
  // only supplies the stream source and the app-specific side effects.
  const { items, input, setInput, busy, send } = useAssistant({
    stream: (prompt) => api.ai.assistant({ prompt }),
    initialInput: "show my notes",
    // ui.navigate is a client action: the server tool returns a path; we route.
    onPart: (part) => {
      if (part.type === "tool" && part.name === "ui.navigate") {
        const to = (part.result as { to?: string })?.to;
        if (to) router.push(to);
      }
    },
    // Speak the reply only when the turn came from voice (meta.spoken).
    onDone: (parts, meta) => {
      if (!meta.spoken) return;
      const text = parts
        .filter((p): p is Extract<ChatPart, { type: "text" }> => p.type === "text")
        .map((p) => p.text)
        .join("")
        .trim();
      if (text && typeof window !== "undefined" && "speechSynthesis" in window) {
        try {
          window.speechSynthesis.cancel();
          window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
        } catch {
          /* TTS unavailable — ignore */
        }
      }
    },
  });

  // Only touch browser-only APIs after mount so SSR and the first client render
  // agree (avoids a hydration mismatch on the voice button).
  useEffect(() => setMounted(true), []);

  // Which external MCP servers are wired into the toolset (shown at the top).
  function refreshServers() {
    api.mcp.servers().then(setServers).catch(() => setServers([]));
  }
  useEffect(refreshServers, []);

  // When an OAuth popup finishes, it postMessages back here.
  useEffect(() => {
    function onMsg(e: MessageEvent) {
      if (e.origin !== window.location.origin) return;
      const data = e.data as { type?: string; ok?: boolean };
      if (data?.type !== "mcp-oauth") return;
      setConnNote("");
      if (data.ok) {
        setConnUrl("");
        setConnName("");
        setShowConnect(false);
        setConnError("");
      } else {
        setConnError("Authorization failed or was denied.");
      }
      refreshServers();
    }
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);

  async function connectServer() {
    const url = connUrl.trim();
    if (!url || connecting) return;
    setConnecting(true);
    setConnError("");
    setConnNote("");
    try {
      const res = await api.mcp.connect({ url, name: connName.trim() || undefined });
      if (res.status === "auth_required") {
        // Server needs OAuth — send the user through the flow in a popup.
        setConnNote("Complete sign-in in the popup to finish connecting…");
        window.open(res.authorizeUrl, "mcp-oauth", "width=520,height=720");
      } else {
        setConnUrl("");
        setConnName("");
        setShowConnect(false);
        refreshServers();
      }
    } catch (e) {
      setConnError((e as Error).message || "Could not connect");
    } finally {
      setConnecting(false);
    }
  }

  async function disconnectServer(id: string) {
    try {
      await api.mcp.disconnect({ id });
    } finally {
      refreshServers();
    }
  }

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [items]);

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
      // Passing an override marks the turn as voice (meta.spoken) → reply is read.
      void send(transcript);
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

      <div style={S.mcpPanel}>
        <div style={S.mcpHead}>
          <span style={{ ...S.dot, background: servers.length ? "#16a34a" : "#999" }} />
          <strong style={{ fontSize: 13 }}>
            MCP connectors ({servers.length})
          </strong>
          <button style={S.addBtn} onClick={() => setShowConnect((v) => !v)}>
            {showConnect ? "Cancel" : "+ Add connector"}
          </button>
        </div>

        {showConnect && (
          <div style={S.connectForm}>
            <input
              style={{ ...S.input, flex: 2 }}
              value={connUrl}
              onChange={(e) => setConnUrl(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && connectServer()}
              placeholder="https://your-mcp-server.com/mcp"
            />
            <input
              style={{ ...S.input, flex: 1 }}
              value={connName}
              onChange={(e) => setConnName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && connectServer()}
              placeholder="name (optional)"
            />
            <button style={S.btn} onClick={connectServer} disabled={connecting}>
              {connecting ? "…" : "Connect"}
            </button>
          </div>
        )}
        {connNote && <div style={S.connNote}>🔐 {connNote}</div>}
        {connError && <div style={S.connErr}>⚠️ {connError}</div>}

        {servers.map((srv) => (
          <div key={srv.id} style={S.srvRow}>
            <div style={S.srvHead}>
              <strong style={{ fontSize: 13 }}>{srv.server}</strong>
              <span style={S.mcpMeta}>{srv.transport}</span>
              {srv.id !== "default" && (
                <button
                  style={S.disconnectBtn}
                  title="Disconnect"
                  onClick={() => disconnectServer(srv.id)}
                >
                  ✕
                </button>
              )}
            </div>
            <div style={S.mcpTools}>
              {srv.tools.length === 0 && <span style={S.dim}>no tools</span>}
              {srv.tools.map((t) => (
                <span key={t.name} style={S.mcpTool} title={t.description}>
                  🔌 {t.name}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>

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
                ) : p.type === "memory" ? (
                  <div key={j} style={S.dim}>
                    🧠 {p.op === "recalled" ? "recalled" : "saved"}{" "}
                    {p.records.length} {p.records.length === 1 ? "memory" : "memories"}
                  </div>
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
  mcpTools: { display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6 },
  mcpTool: { fontSize: 12, color: "#5b21b6", background: "white", border: "1px solid #ddd6fe", borderRadius: 999, padding: "2px 10px", cursor: "default" },
  addBtn: { marginLeft: "auto", fontSize: 12, color: "#5b21b6", background: "white", border: "1px solid #ddd6fe", borderRadius: 8, padding: "3px 10px", cursor: "pointer" },
  connectForm: { display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" },
  connErr: { marginTop: 6, fontSize: 12, color: "#c62828" },
  connNote: { marginTop: 6, fontSize: 12, color: "#6d28d9" },
  srvRow: { marginTop: 10, paddingTop: 8, borderTop: "1px solid #ede9fe" },
  srvHead: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
  disconnectBtn: { marginLeft: "auto", fontSize: 12, color: "#999", background: "transparent", border: "none", cursor: "pointer", lineHeight: 1 },
  inputRow: { display: "flex", gap: 8, position: "sticky", bottom: 16 },
  input: { flex: 1, padding: "10px 12px", borderRadius: 8, border: "1px solid #ccc" },
  btn: { padding: "10px 16px", borderRadius: 8, border: "1px solid #ccc", background: "#fafafa", cursor: "pointer" },
};
