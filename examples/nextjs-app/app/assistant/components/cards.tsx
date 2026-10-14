// Generative-UI card registry: tool name → the React component that renders its
// result. A tool with no entry falls back to GenericCard (collapsed raw JSON).

import type { ChatPart } from "@/lib/chat-types";
import type { Note } from "@/server/db";
import type { MemoryRecord } from "dendra";
import s from "../chat.module.css";

export type ToolPart = Extract<ChatPart, { type: "tool" }>;

function NoteList({ notes }: { notes: Note[] }) {
  if (!notes.length) return <div className={s.card}>No notes yet.</div>;
  return (
    <div className={s.card}>
      <div className={s.cardLabel}>📋 Notes ({notes.length})</div>
      {notes.map((n) => (
        <div key={n.id} className={s.rowItem}>
          <strong>{n.title}</strong>
          <span className={s.muted}> — {n.body}</span>
        </div>
      ))}
    </div>
  );
}

function NoteCard({ note }: { note: Note }) {
  return (
    <div className={`${s.card} ${s.cardGood}`}>
      <div className={s.cardLabel}>✓ Note created</div>
      <strong>{note.title}</strong>
      <div className={s.muted}>{note.body}</div>
      <code className={s.idTag}>{note.id}</code>
    </div>
  );
}

function MemoryCard({ label, records }: { label: string; records: MemoryRecord[] }) {
  return (
    <div className={`${s.card} ${s.cardMemory}`}>
      <div className={s.cardLabel}>
        🧠 {label}
        {records.length > 1 ? ` (${records.length})` : ""}
      </div>
      {records.length === 0 && (
        <div className={s.muted}>Nothing remembered yet.</div>
      )}
      {records.map((r) => (
        <div key={r.id} className={s.rowItem}>
          {r.text}
          {typeof r.score === "number" && (
            <span className={s.memScore}> · {Math.round(r.score * 100)}% match</span>
          )}
        </div>
      ))}
    </div>
  );
}

// Fallback for any unregistered tool: collapsed by default so the transcript
// stays clean; click to expand the raw result.
export function GenericCard({ part }: { part: ToolPart }) {
  return (
    <details className={`${s.card} ${part.isError ? s.cardDanger : ""}`}>
      <summary className={`${s.cardLabel} ${s.genericSummary}`}>
        {part.isError ? "⚠ " : "🔧 "}
        {part.name}
      </summary>
      <pre className={s.pre}>{JSON.stringify(part.result, null, 2)}</pre>
    </details>
  );
}

export const REGISTRY: Record<string, React.FC<{ part: ToolPart }>> = {
  "notes.list": ({ part }) => <NoteList notes={(part.result as Note[]) ?? []} />,
  "notes.create": ({ part }) => <NoteCard note={part.result as Note} />,
  "notes.delete": ({ part }) => (
    <div className={`${s.card} ${s.cardDanger}`}>
      <div className={s.cardLabel}>🗑 Note deleted</div>
      <code className={s.idTag}>{(part.result as { id: string }).id}</code>
    </div>
  ),
  "ai.summarize": ({ part }) => (
    <div className={s.card}>
      <div className={s.cardLabel}>📝 Summary</div>
      {(part.result as { summary: string }).summary}
    </div>
  ),
  "memory.remember": ({ part }) => (
    <MemoryCard label="Remembered" records={[part.result as MemoryRecord]} />
  ),
  "memory.recall": ({ part }) => (
    <MemoryCard label="Recalled" records={(part.result as MemoryRecord[]) ?? []} />
  ),
  "memory.list": ({ part }) => (
    <MemoryCard label="Memory" records={(part.result as MemoryRecord[]) ?? []} />
  ),
  "memory.forget": ({ part }) => (
    <div className={s.card}>
      <div className={s.cardLabel}>
        {(part.result as boolean) ? "🗑 Forgotten" : "🤷 Nothing to forget"}
      </div>
    </div>
  ),
  "ui.navigate": ({ part }) => (
    <div className={s.card}>
      <div className={s.cardLabel}>➡️ Navigating</div>
      <code className={s.idTag}>{(part.result as { to: string }).to}</code>
    </div>
  ),
  // The lazy-tool meta-tool: the model searched for a tool and loaded it.
  search_tools: ({ part }) => {
    const q = (part.input as { query?: string })?.query;
    const found = (part.result as { found?: { name: string }[] })?.found ?? [];
    return (
      <div className={`${s.card} ${s.cardMcp}`}>
        <div className={s.cardLabel}>🔎 Searched tools{q ? ` · “${q}”` : ""}</div>
        {found.length === 0 ? (
          <div className={s.muted}>No matching tools.</div>
        ) : (
          found.map((f) => (
            <div key={f.name} className={s.rowItem}>
              <code>{f.name}</code> <span className={s.muted}>loaded</span>
            </div>
          ))
        )}
      </div>
    );
  },
  "ext.weather.get": ({ part }) => {
    const r = part.result as { city: string; condition: string; tempC: number };
    return (
      <div className={`${s.card} ${s.cardMcp}`}>
        <div className={s.cardLabel}>🔌 via MCP · weather</div>
        <strong>{r.city}</strong>: {r.condition}, {r.tempC}°C
      </div>
    );
  },
  "ext.time.now": ({ part }) => (
    <div className={`${s.card} ${s.cardMcp}`}>
      <div className={s.cardLabel}>🔌 via MCP · time</div>
      <code className={s.idTag}>{(part.result as { now: string }).now}</code>
    </div>
  ),
};

/** Render one tool part through the registry, falling back to GenericCard. */
export function ToolCard({ part }: { part: ToolPart }) {
  const Comp = REGISTRY[part.name] ?? GenericCard;
  return <Comp part={part} />;
}
