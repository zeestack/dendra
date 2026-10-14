// The sticky input bar — auto-growing textarea, optional voice button, send.
// Enter sends; Shift+Enter inserts a newline.

import { useRef, useEffect } from "react";
import s from "../chat.module.css";

export function Composer({
  value,
  onChange,
  onSend,
  busy,
  voice,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  busy: boolean;
  voice?: { supported: boolean; listening: boolean; start: () => void };
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  // Auto-grow the textarea to fit its content (capped by CSS max-height).
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 160) + "px";
  }, [value]);

  return (
    <div className={s.composer}>
      <div className={s.composerInner}>
        <textarea
          ref={ref}
          className={s.textarea}
          rows={1}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              onSend();
            }
          }}
          placeholder="Ask the assistant…"
        />
        {voice?.supported && (
          <button
            className={`${s.iconBtn} ${voice.listening ? s.listening : ""}`}
            onClick={voice.start}
            disabled={busy || voice.listening}
            title="Speak your request"
            aria-label="Voice input"
          >
            {voice.listening ? "🎙️" : "🎤"}
          </button>
        )}
        <button
          className={s.sendBtn}
          onClick={onSend}
          disabled={busy || !value.trim()}
        >
          {busy ? "…" : "Send"}
        </button>
      </div>
    </div>
  );
}
