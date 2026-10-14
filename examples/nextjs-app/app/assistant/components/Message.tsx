// One chat row — a user bubble, or an assistant turn (text bubbles + generative
// tool cards + memory chips). Streaming turns with no parts yet show a typing
// indicator.

import type { AssistantItem } from "dendra/react";
import { ToolCard, type ToolPart } from "./cards";
import { useTypewriter } from "./useTypewriter";
import { Markdown } from "./Markdown";
import s from "../chat.module.css";

// Assistant text, revealed character-by-character as it streams, rendered as
// markdown (code blocks, bold, lists). `live` is true only for the current turn,
// so historical messages render instantly.
function TextBubble({ text, live }: { text: string; live: boolean }) {
  const { text: shown, typing } = useTypewriter(text, live);
  return (
    <div className={`${s.bubble} ${s.bubbleAssistant}`}>
      <Markdown text={shown} />
      {typing && <span className={s.caret} aria-hidden />}
    </div>
  );
}

function Avatar({ role }: { role: "user" | "assistant" }) {
  return (
    <div
      className={`${s.avatar} ${role === "user" ? s.avatarUser : s.avatarAssistant}`}
      aria-hidden
    >
      {role === "user" ? "You" : "✦"}
    </div>
  );
}

export function Message({
  item,
  live = false,
}: {
  item: AssistantItem;
  live?: boolean;
}) {
  if (item.role === "user") {
    return (
      <div className={`${s.row} ${s.user}`}>
        <Avatar role="user" />
        <div className={s.bubbleWrap}>
          <div className={`${s.bubble} ${s.bubbleUser}`}>{item.text}</div>
        </div>
      </div>
    );
  }

  return (
    <div className={s.row}>
      <Avatar role="assistant" />
      <div className={s.bubbleWrap}>
        {item.parts.length === 0 && (
          <div className={`${s.bubble} ${s.bubbleAssistant}`}>
            <span className={s.typing} aria-label="Assistant is typing">
              <span />
              <span />
              <span />
            </span>
          </div>
        )}
        {item.parts.map((p, j) => {
          if (p.type === "text") {
            return p.text.trim() ? (
              <TextBubble key={j} text={p.text} live={live} />
            ) : null;
          }
          if (p.type === "memory") {
            return (
              <div key={j} className={`${s.card} ${s.cardMemory}`}>
                <div className={s.cardLabel}>
                  🧠 {p.op === "recalled" ? "Recalled" : "Saved"} {p.records.length}{" "}
                  {p.records.length === 1 ? "memory" : "memories"}
                </div>
                {p.records.map((r) => (
                  <div key={r.id} className={s.rowItem}>
                    {r.text}
                  </div>
                ))}
              </div>
            );
          }
          return <ToolCard key={j} part={p as ToolPart} />;
        })}
      </div>
    </div>
  );
}
