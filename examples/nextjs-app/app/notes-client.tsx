"use client";

// Client Component. Mutates through the typed HTTP client (`api.notes.create`)
// and stays live by iterating the `api.notes.watch()` subscription — the exact
// same client object, awaited for unary and `for await`-ed for streaming.

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import type { Note } from "@/server/db";

export function NotesClient({ initial }: { initial: Note[] }) {
  const [notes, setNotes] = useState<Note[]>(initial);
  const titleRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLInputElement>(null);

  // Live subscription with auto-reconnect. If the stream ends or errors, we
  // re-fetch the list (to catch anything missed during the gap) and resubscribe
  // after a short delay — so a long-lived tab keeps itself in sync.
  useEffect(() => {
    let active = true;
    (async () => {
      while (active) {
        try {
          for await (const ev of api.notes.watch()) {
            if (!active) break;
            if (ev.type === "created") {
              setNotes((cur) =>
                cur.some((n) => n.id === ev.note.id) ? cur : [...cur, ev.note],
              );
            } else if (ev.type === "deleted") {
              setNotes((cur) => cur.filter((n) => n.id !== ev.id));
            }
          }
        } catch {
          // stream error — fall through to reconnect
        }
        if (!active) break;
        // Stream dropped: re-sync (in case we missed events), then retry.
        api.notes
          .list()
          .then((l) => active && setNotes(l))
          .catch(() => {});
        await new Promise((r) => setTimeout(r, 1500));
      }
    })();
    return () => {
      active = false; // breaks the for-await, which cancels the stream
    };
  }, []);

  // Self-heal: if the tab missed a live event (e.g. it was backgrounded or the
  // stream hiccuped), re-fetch the list whenever the tab regains focus.
  useEffect(() => {
    const refetch = () => {
      api.notes.list().then(setNotes).catch(() => {});
    };
    const onVisible = () => {
      if (!document.hidden) refetch();
    };
    window.addEventListener("focus", refetch);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", refetch);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  async function onAdd(e: React.FormEvent) {
    e.preventDefault();
    const title = titleRef.current?.value ?? "";
    const body = bodyRef.current?.value ?? "";
    if (!title) return;
    // Fully typed; TS rejects wrong argument shapes at compile time.
    await api.notes.create({ title, body });
    if (titleRef.current) titleRef.current.value = "";
    if (bodyRef.current) bodyRef.current.value = "";
    // No optimistic update needed — the subscription will deliver it.
  }

  async function onDelete(id: string) {
    setNotes((cur) => cur.filter((n) => n.id !== id)); // optimistic
    await api.notes.delete({ id });
  }

  return (
    <>
      <form onSubmit={onAdd} style={{ display: "flex", gap: 8, margin: "16px 0" }}>
        <input ref={titleRef} placeholder="Title" />
        <input ref={bodyRef} placeholder="Body" />
        <button type="submit">Add</button>
      </form>
      <ul>
        {notes.map((n) => (
          <li key={n.id} style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ flex: 1 }}>
              <strong>{n.title}</strong> — {n.body}
            </span>
            <button
              onClick={() => onDelete(n.id)}
              title="Delete note"
              style={{ cursor: "pointer", border: "none", background: "none", color: "#c62828" }}
            >
              ✕
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}
