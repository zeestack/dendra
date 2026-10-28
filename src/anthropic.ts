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
import { isPendingResult } from "./approvals.ts";
import { DendraError, publicError } from "./errors.ts";
import { recallMemory, rememberFacts, type MemoryStore } from "./memory.ts";
import type { ContextManager } from "./context-manager.ts";

/**
 * The minimal client surface `runAgent` needs — just `messages.stream`. Typed
 * structurally (not as the concrete `Anthropic` class) so any API-compatible
 * client drops in with no cast: `new Anthropic()`, or **Amazon Bedrock** via
 * `new AnthropicBedrock()` from `@anthropic-ai/bedrock-sdk`.
 */
export interface AnthropicClientLike {
  messages: {
    stream(
      body: Anthropic.MessageStreamParams,
      options?: { signal?: AbortSignal },
    ): AsyncIterable<Anthropic.MessageStreamEvent> & {
      finalMessage(): Promise<Anthropic.Message>;
    };
  };
}

export interface RunAgentOptions {
  /** An Anthropic-compatible client — `new Anthropic()` or `new AnthropicBedrock()`. */
  client: AnthropicClientLike;
  model: string;
  /** Tool schemas in Anthropic format (e.g. from `mergeToolsets().tools`).
   *  Ignored when `lazyToolset` is set (which owns the tool list). */
  tools: unknown[];
  /** Runs a tool the model chose (e.g. `mergeToolsets().execute`). */
  execute: (name: string, args: unknown) => Promise<unknown>;
  /**
   * Opt-in tool-context management (`dendra` `lazyToolset`). When set, the full
   * schemas are NOT sent up front — the model gets a compact menu + a
   * `search_tools` meta-tool and loads tools on demand, keeping a large toolset
   * out of context. `execute` still runs the real tools.
   */
  lazyToolset?: import("./context.ts").LazyToolset;
  /**
   * Opt-in unified context management (`createContextManager`). Supersedes the
   * `memory` / `lazyToolset` / `recall` / `remember` options below: the manager
   * owns recall, lazy tool loading, history compaction, and write-backs under one
   * token budget, emitting `{ type: "context" }` parts. Omit for no manager.
   */
  context?: ContextManager;
  /** The conversation so far, or a single user prompt. */
  messages?: Anthropic.MessageParam[];
  prompt?: string;
  system?: string;
  maxTokens?: number;
  /** Max model↔tool round-trips before stopping (default 6). */
  maxSteps?: number;
  signal?: AbortSignal;

  /**
   * A memory store (e.g. `dendra/memory`'s `createMemoryStore`, or your own).
   * Enables the `recall` / `remember` hooks below. Omit for no memory.
   */
  memory?: MemoryStore;
  /**
   * Before the loop runs, search memory and inject the hits so the model has
   * relevant context. Defaults to `{ k: 6, into: "system" }` when `memory` is
   * set; pass `false` to retrieve nothing. `query` derives the search string
   * from the conversation (default: the last user message).
   */
  recall?:
    | false
    | {
        k?: number;
        into?: "system" | "user";
        minScore?: number;
        query?: (messages: Anthropic.MessageParam[]) => string;
      };
  /**
   * After the loop ends, persist new memories. You supply the function — the
   * framework never decides what to remember. It receives the final assistant
   * text and the full messages, and returns the strings to save (call the model
   * inside for extraction, or write a heuristic). Writes are surfaced as
   * `{ type: "memory", op: "saved" }` parts. Default: off.
   */
  remember?: (turn: {
    text: string;
    messages: Anthropic.MessageParam[];
  }) => string[] | Promise<string[]>;
}

/** Pull plain text out of a message's string-or-blocks content. */
function messageText(m: Anthropic.MessageParam): string {
  if (typeof m.content === "string") return m.content;
  return m.content
    .map((b) =>
      (b as { type: string }).type === "text"
        ? ((b as { text?: string }).text ?? "")
        : "",
    )
    .join(" ")
    .trim();
}

/** The most recent user message as plain text (the default recall query). */
function lastUserText(messages: Anthropic.MessageParam[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      const t = messageText(messages[i]);
      if (t) return t;
    }
  }
  return "";
}

/**
 * Run the agentic loop, yielding typed parts: text deltas as they stream, and a
 * tool part (with its result) each time the model calls a tool. Tool names are
 * sanitized to Anthropic's allowed charset and mapped back on execution, so
 * dotted names like `notes.list` or `ext.weather.get` work transparently.
 *
 * @experimental Outside the 1.0 stability guarantee; may change in a minor release.
 */
export async function* runAgent(opts: RunAgentOptions): AsyncGenerator<AgentPart> {
  const { client, model, execute } = opts;
  const maxSteps = opts.maxSteps ?? 6;

  // Anthropic tool names must match ^[a-zA-Z0-9_-]+$ — ours are dotted, so
  // sanitize for the model and map back on execution. With a lazy toolset the
  // live set GROWS during the loop (search_tools un-defers more), so sanitizing
  // is a reusable step and `tools` is mutable.
  const safeToOriginal = new Map<string, string>();
  const sanitize = (defs: unknown[]): Anthropic.Tool[] =>
    (defs as Anthropic.Tool[]).map((t) => {
      const safe = t.name.replace(/[^a-zA-Z0-9_-]/g, "_");
      safeToOriginal.set(safe, t.name);
      return { ...t, name: safe };
    });
  const lazy = opts.lazyToolset;
  const ctx = opts.context;

  let messages: Anthropic.MessageParam[] =
    opts.messages?.slice() ??
    (opts.prompt !== undefined ? [{ role: "user", content: opts.prompt }] : []);

  let system = opts.system;
  let tools: Anthropic.Tool[];
  // Meta-tool names the context manager routes (instead of executing), e.g.
  // search_tools. Stays empty unless a ContextManager is in play.
  const metaNames = new Set<string>();

  if (ctx) {
    // ── Unified context manager: owns recall, lazy tool loading, history
    // compaction, and write-backs — all under one token budget.
    messages = (await ctx.compact(messages)) as Anthropic.MessageParam[];
    const turn = {
      messages,
      lastUserText: lastUserText(messages),
      signal: opts.signal,
    };
    const prep = await ctx.prepare(turn);
    system = [system, prep.system].filter(Boolean).join("\n\n") || undefined;
    for (const [safe, orig] of prep.nameMap) safeToOriginal.set(safe, orig);
    for (const n of prep.metaNames) metaNames.add(n);
    // A tool source owns the list (its tools are deferred); otherwise the
    // caller's own tools are always-on and the manager only adds meta-tools.
    tools = prep.ownsTools
      ? (prep.tools as Anthropic.Tool[])
      : [...sanitize(opts.tools), ...(prep.tools as Anthropic.Tool[])];
    for (const { source, loaded } of prep.selected) {
      if (loaded.records?.length)
        yield { type: "context", source, op: "recalled", records: loaded.records };
    }
  } else {
    // ── Legacy standalone paths (unchanged): lazyToolset and/or memory.
    if (lazy) {
      // lazyToolset already sanitized names and owns the full safe→original map.
      tools = lazy.tools as Anthropic.Tool[];
      for (const [safe, orig] of lazy.nameMap) safeToOriginal.set(safe, orig);
    } else {
      tools = sanitize(opts.tools);
    }

    // Recall: retrieve relevant memories and inject them before the model runs.
    // The search + formatting is shared (recallMemory); only the query
    // derivation and injection are Anthropic-specific glue.
    if (opts.memory && opts.recall !== false) {
      const r = opts.recall ?? {};
      const query = (r.query ?? lastUserText)(messages);
      const { records, block } = await recallMemory(opts.memory, query, {
        k: r.k,
        minScore: r.minScore,
      });
      if (records.length) {
        if ((r.into ?? "system") === "system") {
          system = [system, block].filter(Boolean).join("\n\n");
        } else {
          messages.unshift({ role: "user", content: block });
        }
        yield { type: "memory", op: "recalled", records };
      }
    }

    // Lazy tools: put the compact menu of deferred tools in the system prompt;
    // the model loads the ones it needs via the search_tools meta-tool.
    if (lazy && lazy.menu) {
      system = [system, lazy.menu].filter(Boolean).join("\n\n");
    }
  }

  // Accumulate the final assistant text so `remember` can extract from it.
  let assistantText = "";

  for (let step = 0; step < maxSteps; step++) {
    const stream = client.messages.stream(
      {
        model,
        max_tokens: opts.maxTokens ?? 1024,
        system,
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
        assistantText += event.delta.text;
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
    if (final.stop_reason !== "tool_use" || toolUses.length === 0) break;

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      const original = safeToOriginal.get(tu.name) ?? tu.name;

      // Context manager meta-tool (search_tools / …): route to the manager,
      // which returns the result for the model plus any tool defs to add to the
      // live set. Emitted as a `{ type: "context", op: "loaded" }` part.
      if (ctx && metaNames.has(tu.name)) {
        const turn = {
          messages,
          lastUserText: lastUserText(messages),
          signal: opts.signal,
        };
        const h = ctx.handle(tu.name, tu.input, turn);
        if (h) {
          const loadedTools = (h.loaded.tools ?? []) as Anthropic.Tool[];
          if (loadedTools.length) tools = [...tools, ...loadedTools];
          yield {
            type: "context",
            source: h.source,
            op: "loaded",
            tools: loadedTools.map((t) => safeToOriginal.get(t.name) ?? t.name),
          };
          toolResults.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: JSON.stringify(h.result),
          });
          continue;
        }
      }

      // Lazy tools: a search_tools call isn't executed — it loads matching tool
      // schemas into the live set for the next step, and returns the matches.
      // `handle` takes the sanitized name; loaded defs are already sanitized.
      const handled = lazy?.handle(tu.name, tu.input);
      if (handled) {
        if (handled.loaded.length)
          tools = [...tools, ...(handled.loaded as Anthropic.Tool[])];
        yield { type: "tool", name: original, input: tu.input, result: handled.result };
        toolResults.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: JSON.stringify(handled.result),
        });
        continue;
      }

      let result: unknown;
      let isError = false;
      try {
        result = await execute(original, tu.input);
      } catch (e) {
        // The model sees a DendraError's message; anything else is masked, since
        // its text can carry internals, and logged here instead.
        if (!(e instanceof DendraError)) console.error(`[dendra] tool '${original}' failed:`, e);
        result = publicError(e).message;
        isError = true;
      }
      // The generative-UI event: the client renders a component for it. Use the
      // original (dotted) name so a client registry keyed by it matches.
      // A confirm tool only proposed the call; the UI shows approve / reject.
      const approvalId = isPendingResult(result) ? result.actionId : undefined;
      yield {
        type: "tool",
        name: original,
        input: tu.input,
        result,
        isError,
        ...(approvalId ? { approvalId } : {}),
      };
      toolResults.push({
        type: "tool_result",
        tool_use_id: tu.id,
        content: JSON.stringify(result),
        is_error: isError,
      });
    }
    messages.push({ role: "user", content: toolResults });
  }

  // ── Write-backs after the turn.
  if (ctx) {
    const turn = {
      messages,
      lastUserText: lastUserText(messages),
      assistantText,
      signal: opts.signal,
    };
    for (const { source, loaded } of await ctx.commit(turn)) {
      if (loaded.records?.length)
        yield { type: "context", source, op: "saved", records: loaded.records };
    }
  } else if (opts.memory && opts.remember) {
    // Legacy: persist whatever the caller's function returns (explicit).
    const facts = await opts.remember({ text: assistantText, messages });
    for (const rec of await rememberFacts(opts.memory, facts)) {
      yield { type: "memory", op: "saved", records: [rec] };
    }
  }
}
