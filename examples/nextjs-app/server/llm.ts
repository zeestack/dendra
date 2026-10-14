// Real LLM wiring. Uses the Anthropic SDK when ANTHROPIC_API_KEY is present
// (read from the environment — never hard-coded, never passed through chat), and
// falls back to a local stub when it's missing OR the API call fails (e.g. an
// invalid key), so the demo always works. Valid key → real streamed tokens.
//
// Set your key in .env.local (see .env.example). Default model is claude-opus-5-5;
// override with ANTHROPIC_MODEL (e.g. claude-haiku-5-5 for a snappier demo).

import Anthropic from "@anthropic-ai/sdk";
import { runAgent } from "dendra/anthropic";
import type { LazyToolset } from "dendra";
import type { ChatPart } from "../lib/chat-types.ts";

const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-opus-5-5";

let client: Anthropic | null = null;
// A per-request key (BYOK) wins; otherwise fall back to the server env key. The
// BYOK client isn't cached — it lives only for this request and is never stored.
function getClient(apiKey?: string): Anthropic | null {
  if (apiKey) return new Anthropic({ apiKey });
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!client) client = new Anthropic(); // reads ANTHROPIC_API_KEY from env
  return client;
}

export function llmAvailable(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

/** Stream a chat reply token-by-token. Honors an AbortSignal (client disconnect). */
export async function* streamChat(
  prompt: string,
  signal?: AbortSignal,
  apiKey?: string,
): AsyncGenerator<string> {
  const c = getClient(apiKey);
  if (c) {
    try {
      const stream = c.messages.stream(
        {
          model: MODEL,
          max_tokens: 1024,
          messages: [{ role: "user", content: prompt }],
        },
        { signal },
      );
      for await (const event of stream) {
        if (
          event.type === "content_block_delta" &&
          event.delta.type === "text_delta"
        ) {
          yield event.delta.text;
        }
      }
      return;
    } catch (e) {
      if (signal?.aborted) return; // client disconnected — not an error
      yield `⚠️ LLM unavailable (${briefError(e)}); echo fallback:\n`;
      // fall through to the stub
    }
  }
  for (const word of echoReply(prompt).split(" ")) {
    await sleep(30);
    yield word + " ";
  }
}

/** One-shot summary. Returns a single sentence. */
export async function summarize(text: string, apiKey?: string): Promise<string> {
  const c = getClient(apiKey);
  if (c) {
    try {
      const res = await c.messages.create({
        model: MODEL,
        max_tokens: 256,
        system:
          "Summarize the user's text in one concise sentence. Return only the sentence.",
        messages: [{ role: "user", content: text }],
      });
      const block = res.content.find(
        (b): b is Anthropic.TextBlock => b.type === "text",
      );
      if (block) return block.text;
    } catch {
      // fall through to the stub
    }
  }
  return text.split(/\s+/).slice(0, 12).join(" ") + "…";
}

/**
 * Generative-UI assistant. The agentic loop itself is the framework's `runAgent`
 * (from `dendra/anthropic`) — tool-name sanitizing, thinking-block handling, the
 * model↔tool loop, and typed-part streaming are all handled there. This wrapper
 * just supplies the client/model and the no-key fallback. `tools` and `execute`
 * come from the router (via mergeToolsets).
 */
export async function* streamAssistant(
  messages: Anthropic.MessageParam[],
  opts: {
    tools: unknown[];
    execute: (name: string, args: unknown) => Promise<unknown>;
    system?: string;
    signal?: AbortSignal;
    apiKey?: string;
    lazyToolset?: LazyToolset;
  },
): AsyncGenerator<ChatPart> {
  const c = getClient(opts.apiKey);
  if (!c) {
    yield {
      type: "text",
      text: "(No Anthropic API key — add your own with the key button in the top bar, or set ANTHROPIC_API_KEY in .env.local.)",
    };
    return;
  }
  // AgentPart and ChatPart are the same shape — one line, the whole loop. We pass
  // the FULL conversation (messages), not just the latest prompt, so the model has
  // continuity across turns.
  yield* runAgent({
    client: c,
    model: MODEL,
    tools: opts.tools,
    execute: opts.execute,
    lazyToolset: opts.lazyToolset,
    messages,
    system: opts.system,
    signal: opts.signal,
  });
}

function echoReply(prompt: string): string {
  return `(no valid ANTHROPIC_API_KEY — echoing) ${prompt}`;
}
function briefError(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.length > 60 ? m.slice(0, 60) + "…" : m;
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
