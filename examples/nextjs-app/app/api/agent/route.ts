// AI agent endpoint. The router's `.ai()`-exposed procedures become tools; the
// model picks tools, we execute them with createToolExecutor (validated, and
// scoped to the user's context — not god mode), then feed results back. This
// sketch uses the Anthropic SDK shape; the same tools work with the Vercel AI SDK
// or TanStack AI.

import Anthropic from "@anthropic-ai/sdk";
import { toToolset, createToolExecutor } from "dendra";
import { appRouter } from "@/server/router";
import { createContext } from "@/server/context";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const { messages } = (await req.json()) as { messages: Anthropic.MessageParam[] };

  const client = new Anthropic();
  const tools = toToolset(appRouter, {
    format: "anthropic",
  }) as Anthropic.Tool[];
  // ctx comes from the request (cookie or bearer token), never from the body:
  // the model acts with the signed-in user's permissions, and only theirs.
  const execute = createToolExecutor(appRouter, await createContext(req));

  const convo: Anthropic.MessageParam[] = [...messages];

  // Minimal agentic loop: call model → run any tool_use → repeat until it stops.
  for (let step = 0; step < 5; step++) {
    const res = await client.messages.create({
      model: process.env.ANTHROPIC_MODEL ?? "claude-opus-5-5",
      max_tokens: 1024,
      tools,
      messages: convo,
    });

    convo.push({ role: "assistant", content: res.content });

    const toolUses = res.content.filter((b) => b.type === "tool_use");
    if (res.stop_reason !== "tool_use" || toolUses.length === 0) {
      return Response.json({ messages: convo });
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      try {
        const result = await execute(tu.name, tu.input); // validated here
        toolResults.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: JSON.stringify(result),
        });
      } catch (e) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: tu.id,
          is_error: true,
          content: (e as Error).message,
        });
      }
    }
    convo.push({ role: "user", content: toolResults });
  }

  return Response.json({ messages: convo });
}
