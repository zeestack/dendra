// Optional helper: a headless React hook for assistant chat. Imported via the
// `dendra/react` subpath so core stays zero-dependency — `react` is an optional
// peer dependency you only need if you use this file.
//
// `useAssistant` consumes the same `AgentPart` stream that `runAgent` (from
// `dendra/anthropic`) produces: it tracks the message thread, accumulates text
// deltas, appends tool parts, and exposes `send`/`busy`. You keep full control of
// rendering (the generative-UI registry is yours) and of per-part side effects
// (navigation, text-to-speech) via `onPart`.
//
// `useJob` follows a background job to completion over its watch procedure,
// reconnecting as needed (see `followJob`).

import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentPart } from "./agent.ts";
import { followJob, type FollowedJob, type FollowJobOptions, type JobSnapshotLike } from "./follow-job.ts";

export type AssistantItem =
  | { role: "user"; text: string }
  | { role: "assistant"; parts: AgentPart[] };

export interface UseAssistantOptions {
  /**
   * Starts a turn. Receives the new prompt and the thread so far (`history`,
   * the items before this turn), so you can send conversation history to the
   * server for multi-turn continuity. `history` is optional to stay
   * backward-compatible — ignore it for a stateless, single-turn assistant.
   */
  stream: (
    prompt: string,
    history: AssistantItem[],
  ) => AsyncIterable<AgentPart>;
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

/**
 * Headless chat state over an `AgentPart` stream (e.g. from `runAgent`).
 *
 * @experimental Outside the 1.0 stability guarantee; may change in a minor release.
 */
export function useAssistant(opts: UseAssistantOptions): UseAssistant {
  const { stream, onPart, onDone } = opts;
  const [items, setItems] = useState<AssistantItem[]>(opts.initialItems ?? []);
  const [input, setInput] = useState(opts.initialInput ?? "");
  const [busy, setBusy] = useState(false);
  // Mirror the thread in a ref so `send` can read the latest items (the history
  // before this turn) without being re-created on every message.
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const send = useCallback(
    async (override?: string) => {
      const prompt = (override ?? input).trim();
      if (!prompt || busy) return;
      const history = itemsRef.current; // the thread so far, before this turn
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
        for await (const part of stream(prompt, history)) {
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

const IDLE: FollowedJob<never> = { job: null, connection: "idle", error: null };
const CONNECTING: FollowedJob<never> = { job: null, connection: "connecting", error: null };

/**
 * Follow a job by id: the latest snapshot (`job.status`, `job.progress`,
 * `job.result`, `job.error`), how the watch is doing (`connection`), and
 * `error` if following stopped early (e.g. `NOT_FOUND`). Stops when the job
 * settles, the id changes, or the component unmounts; a `null` id is idle.
 *
 *   const { job } = useJob(jobId, (id, signal) => api.jobs.watch({ jobId: id }, { signal }));
 *
 * `open` may be an inline function; only `jobId` restarts the watch.
 */
export function useJob<S extends JobSnapshotLike>(
  jobId: string | null | undefined,
  open: (jobId: string, signal: AbortSignal) => AsyncIterable<S>,
  opts: Pick<FollowJobOptions, "backoff" | "online"> = {},
): FollowedJob<S> {
  const openRef = useRef(open);
  openRef.current = open;
  const optsRef = useRef(opts);
  optsRef.current = opts;
  // Keyed by id, so a new id never shows the previous job's state.
  const [current, setCurrent] = useState<{ id: string; state: FollowedJob<S> } | null>(null);

  useEffect(() => {
    if (!jobId) return;
    const follower = followJob<S>((signal) => openRef.current(jobId, signal), optsRef.current);
    setCurrent({ id: jobId, state: follower.get() });
    const off = follower.subscribe((state) => setCurrent({ id: jobId, state }));
    return () => {
      off();
      follower.stop();
    };
  }, [jobId]);

  if (!jobId) return IDLE;
  return current?.id === jobId ? current.state : CONNECTING;
}
