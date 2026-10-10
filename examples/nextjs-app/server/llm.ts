// Real LLM wiring. Uses the Anthropic SDK when ANTHROPIC_API_KEY is present
// (read from the environment — never hard-coded, never passed through chat), and
// falls back to a local stub when it's missing OR the API call fails (e.g. an
// invalid key), so the demo always works. Valid key → real streamed tokens.
//
// Set your key in .env.local (see .env.example). Default model is claude-opus-5-5;
// override with ANTHROPIC_MODEL (e.g. claude-haiku-5-5 for a snappier demo).

import Anthropic from "@anthropic-ai/sdk";
import type { ChatPart } from "../lib/chat-types.ts";

const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-opus-5-5";

let client: Anthropic | null = null;
function getClient(): Anthropic | null {
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
): AsyncGenerator<string> {
  const c = getClient();
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
export async function summarize(text: string): Promise<string> {
  const c = getClient();
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
 * Generative-UI assistant: runs the agentic loop and yields typed PARTS —
 * text deltas as they stream, and a tool part (with its result) each time the
 * model calls a tool. The client renders a component per tool part.
 * `tools` and `execute` are supplied by the router (from the same appRouter).
 */
export async function* streamAssistant(
  prompt: string,
  opts: {
    tools: unknown[];
    execute: (name: string, args: unknown) => Promise<unknown>;
    system?: string;
    signal?: AbortSignal;
  },
): AsyncGenerator<ChatPart> {
  const c = getClient();
  if (!c) {
    yield { type: "text", text: "(no valid ANTHROPIC_API_KEY — set one in .env.local)" };
    return;
  }

  // Anthropic tool names must match ^[a-zA-Z0-9_-]+$ — our names are dotted
  // (notes.list), so sanitize for the model and map back on execution. The
  // client registry stays keyed by the real dotted name.
  const safeToOriginal = new Map<string, string>();
  const tools = (opts.tools as Anthropic.Tool[]).map((t) => {
    const safe = t.name.replace(/[^a-zA-Z0-9_-]/g, "_");
    safeToOriginal.set(safe, t.name);
    return { ...t, name: safe };
  });

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: prompt },
  ];

  // A few hops max: model → tool(s) → model → … → final text.
  for (let step = 0; step < 4; step++) {
    const stream = c.messages.stream(
      { model: MODEL, max_tokens: 1024, system: opts.system, tools, messages },
      { signal: opts.signal },
    );
    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        yield { type: "text", text: event.delta.text };
      }
    }

    const final = await stream.finalMessage();
    messages.push({ role: "assistant", content: final.content });

    const toolUses = final.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );
    if (final.stop_reason !== "tool_use" || toolUses.length === 0) return;

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      const original = safeToOriginal.get(tu.name) ?? tu.name;
      let result: unknown;
      let isError = false;
      try {
        result = await opts.execute(original, tu.input);
      } catch (e) {
        result = (e as Error).message;
        isError = true;
      }
      // This is the generative-UI event: the client renders a component for it.
      // Use the original dotted name so the client registry matches.
      yield { type: "tool", name: original, input: tu.input, result, isError };
      toolResults.push({
        type: "tool_result",
        tool_use_id: tu.id,
        content: JSON.stringify(result),
        is_error: isError,
      });
    }
    messages.push({ role: "user", content: toolResults });
  }
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
