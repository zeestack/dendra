// Optional helper: a headless React hook for assistant chat. Imported via the
// `dendra/react` subpath so core stays zero-dependency — `react` is an optional
// peer dependency you only need if you use this file.
//
// `useAssistant` consumes the same `AgentPart` stream that `runAgent` (from
// `dendra/anthropic`) produces: it tracks the message thread, accumulates text
// deltas, appends tool parts, and exposes `send`/`busy`. You keep full control of
// rendering (the generative-UI registry is yours) and of per-part side effects
// (navigation, text-to-speech) via `onPart`.

import { useCallback, useState } from "react";
import type { AgentPart } from "./agent.ts";

export type AssistantItem =
  | { role: "user"; text: string }
  | { role: "assistant"; parts: AgentPart[] };

export interface UseAssistantOptions {
  /** Starts a turn: given a prompt, returns the streamed parts. */
  stream: (prompt: string) => AsyncIterable<AgentPart>;
  /** Called for every streamed part (e.g. to act on a tool as it arrives). */
  onPart?: (part: AgentPart, meta: { spoken: boolean }) => void;
  /** Called once a turn finishes, with all of that turn's parts (e.g. for TTS). */
  onDone?: (parts: AgentPart[], meta: { spoken: boolean }) => void;
  /** Seed the thread with existing items. */
  initialItems?: AssistantItem[];
  /** Prefill the input box. */
  initialInput?: string;
}

export interface UseAssistant {
  items: AssistantItem[];
  input: string;
  setInput: (v: string) => void;
  busy: boolean;
  /** Send the current input, or an override (e.g. a voice transcript). */
  send: (override?: string) => Promise<void>;
  /** Clear the thread. */
  reset: () => void;
}

export function useAssistant(opts: UseAssistantOptions): UseAssistant {
  const { stream, onPart, onDone } = opts;
  const [items, setItems] = useState<AssistantItem[]>(opts.initialItems ?? []);
  const [input, setInput] = useState(opts.initialInput ?? "");
  const [busy, setBusy] = useState(false);

  const send = useCallback(
    async (override?: string) => {
      const prompt = (override ?? input).trim();
      if (!prompt || busy) return;
      setInput("");
      setBusy(true);
      setItems((c) => [
        ...c,
        { role: "user", text: prompt },
        { role: "assistant", parts: [] },
      ]);
      const spoken = override !== undefined; // override ⇒ came from voice, etc.
      const turn: AgentPart[] = [];
      try {
        for await (const part of stream(prompt)) {
          turn.push(part);
          onPart?.(part, { spoken });
          setItems((c) => {
            const copy = c.slice();
            const last = copy[copy.length - 1];
            if (last?.role !== "assistant") return c;
            const parts = last.parts.slice();
            const prev = parts[parts.length - 1];
            // Coalesce consecutive text deltas into one part.
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
        onDone?.(turn, { spoken });
      }
    },
    [input, busy, stream, onPart, onDone],
  );

  const reset = useCallback(() => setItems([]), []);

  return { items, input, setInput, busy, send, reset };
}
