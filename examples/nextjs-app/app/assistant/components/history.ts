// Flatten the assistant thread into plain chat messages for the stateless server.
// User turns map 1:1; assistant turns contribute their TEXT (tool/memory parts
// are UI-only and aren't replayed). Empty assistant turns are skipped so we never
// send a blank message.

import type { AssistantItem } from "dendra/react";

export type ChatMessage = { role: "user" | "assistant"; content: string };

export function historyToMessages(history: AssistantItem[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const it of history) {
    if (it.role === "user") {
      out.push({ role: "user", content: it.text });
    } else {
      const text = it.parts
        .filter((p): p is { type: "text"; text: string } => p.type === "text")
        .map((p) => p.text)
        .join("");
      if (text.trim()) out.push({ role: "assistant", content: text });
    }
  }
  return out;
}
