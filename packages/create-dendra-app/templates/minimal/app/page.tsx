"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { Note } from "@/server/context";

export default function Home() {
  const [sum, setSum] = useState<number | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");

  function refresh() {
    api.notes.list().then(setNotes);
  }
  useEffect(() => {
    api.add({ a: 40, b: 2 }).then(setSum); // typed: Promise<number>, no codegen
    refresh();
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
        One procedure, many surfaces — built with{" "}
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

      <p style={{ color: "#777", fontSize: 14 }}>
        Give <code>notes.create</code> a path (<code>.post(&quot;/notes&quot;)</code>) and mount
        the REST adapter to also serve REST + OpenAPI, or add <code>.ai()</code> to expose it
        as an MCP tool. One definition, many surfaces — edit <code>server/router.ts</code>.
      </p>
    </main>
  );
}
