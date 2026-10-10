// AI tool support falls out for free: a procedure already has a name, an input
// JSON Schema (the same one used for OpenAPI), and a validated handler. So an
// LLM tool is just a fourth projection of the same definition. Only `.ai()`-
// exposed procedures are included (opt-in, never default) and execution runs
// through the normal validation + context path, so hallucinated arguments are
// rejected and the model inherits the user's permissions — not god mode.

import type { AnyProc, RouterRecord } from "./core.ts";
import type { JSONSchema } from "./schema.ts";
import { invokeStream, invokeUnary, resolveProc } from "./core.ts";

export type ToolFormat = "anthropic" | "openai" | "plain";

export interface PlainTool {
  name: string;
  description: string;
  inputSchema: JSONSchema;
}

export function toToolset(
  router: object,
  opts: { format?: ToolFormat } = {},
): unknown[] {
  const format = opts.format ?? "anthropic";
  const tools: unknown[] = [];

  const walk = (node: RouterRecord, path: string[]): void => {
    for (const k of Object.keys(node)) {
      const child = node[k];
      if ((child as AnyProc)._nexus) {
        const proc = child as AnyProc;
        if (!proc.ai?.expose) continue;
        const name = [...path, k].join(".");
        const schema: JSONSchema = proc.inputJsonSchema ?? {
          type: "object",
          properties: {},
        };
        const description = proc.ai.description ?? proc.description ?? name;
        if (format === "openai") {
          tools.push({
            type: "function",
            function: { name, description, parameters: schema },
          });
        } else if (format === "anthropic") {
          tools.push({ name, description, input_schema: schema });
        } else {
          tools.push({ name, description, inputSchema: schema } satisfies PlainTool);
        }
      } else {
        walk(child as RouterRecord, [...path, k]);
      }
    }
  };

  walk(router as RouterRecord, []);
  return tools;
}

/** Execute a tool call the model requested, by name, with the same safety as HTTP. */
export function createToolExecutor<Ctx>(
  router: object,
  ctx: Ctx,
): (name: string, args: unknown) => Promise<unknown> {
  return async (name: string, args: unknown) => {
    const proc = resolveProc(router as RouterRecord, name.split("."));
    if (!proc) throw new Error(`Tool '${name}' not found`);
    if (!proc.ai?.expose) throw new Error(`Tool '${name}' is not exposed to AI`);
    // Streaming tools: collect the chunks into a single result (join strings,
    // else return the array) so a streaming procedure can be an LLM/MCP tool.
    // Validation runs first in both paths — the guardrail on model output.
    if (proc.kind === "stream") {
      const chunks: unknown[] = [];
      for await (const chunk of invokeStream(proc, args, ctx)) chunks.push(chunk);
      return chunks.every((c) => typeof c === "string")
        ? chunks.join("")
        : chunks;
    }
    return invokeUnary(proc, args, ctx);
  };
}
