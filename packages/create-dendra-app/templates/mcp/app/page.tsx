"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { Note } from "@/server/context";

type Tool = { name: string; description: string };

export default function Home() {
  const [sum, setSum] = useState<number | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [tools, setTools] = useState<Tool[]>([]);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");

  function refresh() {
    api.notes.list().then(setNotes);
  }
  useEffect(() => {
    api.add({ a: 40, b: 2 }).then(setSum);
    refresh();
    // Ask our own MCP endpoint what tools it exposes (exactly what Claude sees).
    fetch("/api/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    })
      .then((r) => r.json())
      .then((j) => setTools(j?.result?.tools ?? []))
      .catch(() => {});
  }, []);

  async function addNote() {
    if (!title.trim()) return;
    await api.notes.create({ title, body });
    setTitle("");
    setBody("");
    refresh();
  }

  return (
    <main>
      <h1>{`{{projectName}}`}</h1>
      <p>
        Your API is also an MCP server — built with{" "}
        <a href="https://github.com/zeestack/dendra">dendra</a>.
      </p>

      <p>
        <code>api.add(40, 2)</code> = <strong>{sum ?? "…"}</strong>{" "}
        <small style={{ color: "#777" }}>(typed &amp; inferred — no codegen)</small>
      </p>

      <h2>Notes</h2>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <input placeholder="title" value={title} onChange={(e) => setTitle(e.target.value)} />
        <input placeholder="body" value={body} onChange={(e) => setBody(e.target.value)} />
        <button onClick={addNote}>Add</button>
      </div>
      <ul>
        {notes.map((n) => (
          <li key={n.id}>
            <strong>{n.title}</strong> — {n.body}
          </li>
        ))}
        {notes.length === 0 && <li style={{ color: "#777" }}>No notes yet.</li>}
      </ul>

      <h2>🔌 Tools exposed to Claude (via MCP)</h2>
      <p style={{ color: "#777", fontSize: 14 }}>
        Live from your own <code>/api/mcp</code> endpoint — the same tools Claude sees:
      </p>
      <ul>
        {tools.map((t) => (
          <li key={t.name}>
            <code>{t.name}</code> — {t.description}
          </li>
        ))}
        {tools.length === 0 && <li style={{ color: "#777" }}>Loading…</li>}
      </ul>
      <p style={{ color: "#777", fontSize: 14 }}>
        Connect Claude: add this project to your Claude Desktop config (stdio), or point
        claude.ai at the remote <code>/api/mcp</code> endpoint. Step-by-step guide (config
        path, the exact JSON, verify) is in this project&apos;s <strong>README</strong>.
      </p>
    </main>
  );
}
