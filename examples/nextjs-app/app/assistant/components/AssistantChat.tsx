"use client";

// The assistant chat container. Owns the framework hook (useAssistant) and the
// app-specific side effects (client-side navigation on ui.navigate, text-to-
// speech for voice turns), and composes the presentational pieces. The thread,
// streaming, and text accumulation all live in useAssistant.

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useAssistant } from "dendra/react";
import type { ChatPart } from "@/lib/chat-types";
import { api } from "@/lib/api";
import { Message } from "./Message";
import { Composer } from "./Composer";
import { Connectors } from "./Connectors";
import { useVoice } from "./useVoice";
import { historyToMessages } from "./history";
import s from "../chat.module.css";

const SUGGESTIONS = [
  "show my notes",
  "remember that I prefer TypeScript",
  "what do you remember about me?",
  "what's the weather in Tokyo?",
];

export function AssistantChat() {
  const router = useRouter();
  const [connectorsOpen, setConnectorsOpen] = useState(false);
  const [serverCount, setServerCount] = useState(0);
  const bottom = useRef<HTMLDivElement>(null);
  // Track whether the latest turn came from voice (so only voice replies are
  // read aloud) — independent of how we pass the prompt text to `send`.
  const spokenRef = useRef(false);

  const { items, input, setInput, busy, send } = useAssistant({
    // Send the WHOLE conversation each turn (the server is stateless), so the
    // model keeps continuity. We replay text turns; prior tool results aren't
    // replayed — the model can re-call a tool if it needs fresh data.
    stream: (prompt, history) =>
      api.ai.assistant({
        messages: [...historyToMessages(history), { role: "user", content: prompt }],
      }),
    // ui.navigate is a client action: the server tool returns a path; we route.
    onPart: (part) => {
      if (part.type === "tool" && part.name === "ui.navigate") {
        const to = (part.result as { to?: string })?.to;
        if (to) router.push(to);
      }
    },
    // Read the reply aloud only when the turn came from voice (tracked locally,
    // so clicking a suggestion — which also passes text to send — stays silent).
    onDone: (parts) => {
      if (!spokenRef.current) return;
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

  // Single entry point for sending. `text` omitted ⇒ send the input box.
  function submit(text?: string, spoken = false) {
    spokenRef.current = spoken;
    void send(text);
  }

  const voice = useVoice((transcript) => {
    setInput(transcript);
    submit(transcript, true); // voice turn ⇒ reply is read aloud
  });

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [items]);

  // Keep the view pinned to the bottom while a reply types out — the typewriter
  // animates between stream deltas, so an items-change effect alone would lag.
  useEffect(() => {
    if (!busy) return;
    const id = setInterval(
      () => bottom.current?.scrollIntoView({ behavior: "auto" }),
      120,
    );
    return () => clearInterval(id);
  }, [busy]);

  return (
    <div className={s.app}>
      <div className={s.shell}>
        <header className={s.header}>
          <div className={s.avatar + " " + s.avatarAssistant} aria-hidden>
            ✦
          </div>
          <div className={s.headerText}>
            <span className={s.title}>Assistant</span>
            <span className={s.subtitle}>
              Typed tools, streamed as live components — built on dendra
            </span>
          </div>
          <div className={s.spacer} />
          <button
            className={s.ghostBtn}
            onClick={() => setConnectorsOpen((v) => !v)}
          >
            <span
              className={s.statusDot}
              style={{ background: serverCount ? "var(--good)" : "var(--fg-muted)" }}
            />
            Connectors ({serverCount})
          </button>
        </header>

        <Connectors open={connectorsOpen} onCountChange={setServerCount} />

        <div className={s.messages}>
          {items.length === 0 ? (
            <div className={s.empty}>
              <div className={s.emptyTitle}>What can I help you with?</div>
              <div className={s.chips}>
                {SUGGESTIONS.map((q) => (
                  <button key={q} className={s.chip} onClick={() => submit(q)}>
                    {q}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            items.map((it, i) => <Message key={i} item={it} />)
          )}
          <div ref={bottom} />
        </div>

        <Composer
          value={input}
          onChange={setInput}
          onSend={() => submit()}
          busy={busy}
          voice={voice}
        />
      </div>
    </div>
  );
}
