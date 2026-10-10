// Optional helper: the agentic loop for Anthropic. Imported via the `dendra/anthropic`
// subpath so core stays zero-dependency — `@anthropic-ai/sdk` is an optional peer
// dependency you only need if you use this file.
//
// `runAgent` is the ~60 lines every tool-using chat app rewrites: model → tool(s)
// → model → … → final text, streaming typed PARTS as it goes. Pair it with
// `mergeToolsets` (for the tools + executor) and, on the client, `useAssistant`
// (from `dendra/react`) which renders the same `AgentPart` stream.

import type Anthropic from "@anthropic-ai/sdk";
import type { AgentPart } from "./agent.ts";

export interface RunAgentOptions {
  /** An Anthropic client instance (`new Anthropic()`). */
  client: Anthropic;
  model: string;
  /** Tool schemas in Anthropic format (e.g. from `mergeToolsets().tools`). */
  tools: unknown[];
  /** Runs a tool the model chose (e.g. `mergeToolsets().execute`). */
  execute: (name: string, args: unknown) => Promise<unknown>;
  /** The conversation so far, or a single user prompt. */
  messages?: Anthropic.MessageParam[];
  prompt?: string;
  system?: string;
  maxTokens?: number;
  /** Max model↔tool round-trips before stopping (default 6). */
  maxSteps?: number;
  signal?: AbortSignal;
}

/**
 * Run the agentic loop, yielding typed parts: text deltas as they stream, and a
 * tool part (with its result) each time the model calls a tool. Tool names are
 * sanitized to Anthropic's allowed charset and mapped back on execution, so
 * dotted names like `notes.list` or `ext.weather.get` work transparently.
 */
export async function* runAgent(opts: RunAgentOptions): AsyncGenerator<AgentPart> {
  const { client, model, execute } = opts;
  const maxSteps = opts.maxSteps ?? 6;

  // Anthropic tool names must match ^[a-zA-Z0-9_-]+$ — ours are dotted, so
  // sanitize for the model and map back on execution.
  const safeToOriginal = new Map<string, string>();
  const tools = (opts.tools as Anthropic.Tool[]).map((t) => {
    const safe = t.name.replace(/[^a-zA-Z0-9_-]/g, "_");
    safeToOriginal.set(safe, t.name);
    return { ...t, name: safe };
  });

  const messages: Anthropic.MessageParam[] =
    opts.messages?.slice() ??
    (opts.prompt !== undefined ? [{ role: "user", content: opts.prompt }] : []);

  for (let step = 0; step < maxSteps; step++) {
    const stream = client.messages.stream(
      {
        model,
        max_tokens: opts.maxTokens ?? 1024,
        system: opts.system,
        tools,
        messages,
      },
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
    // Thinking models (e.g. Opus) return thinking blocks that may be empty under
    // display "omitted"; echoing an empty one back is a 400. Strip them — only
    // text + tool_use blocks are needed to continue the loop.
    const replayContent = final.content.filter((b) => {
      const t = (b as { type: string }).type;
      return t !== "thinking" && t !== "redacted_thinking";
    });
    messages.push({ role: "assistant", content: replayContent });

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
        result = await execute(original, tu.input);
      } catch (e) {
        result = (e as Error).message;
        isError = true;
      }
      // The generative-UI event: the client renders a component for it. Use the
      // original (dotted) name so a client registry keyed by it matches.
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
