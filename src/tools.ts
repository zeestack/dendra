// AI tool support falls out for free: a procedure already has a name, an input
// JSON Schema (the same one used for OpenAPI), and a validated handler. So an
// LLM tool is just a fourth projection of the same definition. Only `.ai()`-
// exposed procedures are included (opt-in, never default) and execution runs
// through the normal validation + context path, so hallucinated arguments are
// rejected and the model inherits the user's permissions — not god mode.

import type { AnyProc, RouterRecord } from "./core.ts";
import type { JSONSchema } from "./schema.ts";
import { invokeStream, invokeUnary, resolveProc } from "./core.ts";
import { collect, proposers, type Approvals } from "./approvals.ts";

/** Appended to a confirm tool's description, so the model knows what to expect. */
const CONFIRM_NOTE =
  " (Needs a person's approval: calling it returns a pending action, not the result.)";

export type ToolFormat = "anthropic" | "openai" | "plain";

export interface PlainTool {
  name: string;
  description: string;
  inputSchema: JSONSchema;
}

/**
 * Shape a single tool for a given LLM provider. Shared by the router projection
 * (`toToolset`) and any external tool source (e.g. an MCP server), so a local
 * procedure and a remote MCP tool look identical to the model.
 */
export function formatTool(
  name: string,
  description: string,
  schema: JSONSchema,
  format: ToolFormat,
): unknown {
  if (format === "openai") {
    return { type: "function", function: { name, description, parameters: schema } };
  }
  if (format === "anthropic") {
    return { name, description, input_schema: schema };
  }
  return { name, description, inputSchema: schema } satisfies PlainTool;
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
      if ((child as AnyProc)._dendra) {
        const proc = child as AnyProc;
        if (!proc.ai?.expose) continue;
        const name = [...path, k].join(".");
        const schema: JSONSchema = proc.inputJsonSchema ?? {
          type: "object",
          properties: {},
        };
        const description =
          (proc.ai.description ?? proc.description ?? name) +
          (proc.ai.confirm ? CONFIRM_NOTE : "");
        tools.push(formatTool(name, description, schema, format));
      } else {
        walk(child as RouterRecord, [...path, k]);
      }
    }
  };

  walk(router as RouterRecord, []);
  return tools;
}

/**
 * A uniform toolset: schemas formatted for the model, the names it owns, and a
 * dispatcher. Local procedures and external MCP servers are both expressed as a
 * `ToolSource`, so they can be merged into one flat toolset (`mergeToolsets`).
 */
export interface ToolSource {
  /** Tool schemas, formatted for the chosen provider. */
  tools: unknown[];
  /** The tool names this source answers to (for routing). */
  names: string[];
  /** Run one of this source's tools by name. */
  execute(name: string, args: unknown): Promise<unknown>;
}

/** Wrap a dendra router + ctx as a `ToolSource` (the local tools). */
export function toToolSource<Ctx>(
  router: object,
  ctx: Ctx,
  opts: { format?: ToolFormat; approvals?: Approvals<Ctx> } = {},
): ToolSource {
  const format = opts.format ?? "anthropic";
  const names = (toToolset(router, { format: "plain" }) as PlainTool[]).map(
    (t) => t.name,
  );
  return {
    tools: toToolset(router, { format }),
    names,
    execute: createToolExecutor(router, ctx, { approvals: opts.approvals }),
  };
}

/**
 * Merge several tool sources into one flat toolset + dispatcher. The model sees
 * a single list and can't tell local procedures from remote MCP tools; each
 * call is routed back to the source that owns the name. Duplicate names across
 * sources are rejected at merge time (prefix one source to disambiguate).
 */
export function mergeToolsets(...sources: ToolSource[]): {
  tools: unknown[];
  execute: (name: string, args: unknown) => Promise<unknown>;
} {
  const owner = new Map<string, ToolSource>();
  for (const src of sources) {
    for (const name of src.names) {
      if (owner.has(name)) {
        throw new Error(
          `mergeToolsets: duplicate tool name across sources: '${name}'`,
        );
      }
      owner.set(name, src);
    }
  }
  return {
    tools: sources.flatMap((s) => s.tools),
    execute: (name, args) => {
      const src = owner.get(name);
      if (!src) throw new Error(`Tool '${name}' not found in any source`);
      return src.execute(name, args);
    },
  };
}

/**
 * Execute a tool call the model requested, by name, with the same safety as
 * HTTP. A confirm tool (`.ai({ confirm: true })`) is only proposed, via
 * `approvals`; without them it fails closed and never runs.
 */
export function createToolExecutor<Ctx>(
  router: object,
  ctx: Ctx,
  opts: { approvals?: Approvals<Ctx> } = {},
): (name: string, args: unknown) => Promise<unknown> {
  return async (name: string, args: unknown) => {
    const proc = resolveProc(router as RouterRecord, name.split("."));
    if (!proc) throw new Error(`Tool '${name}' not found`);
    if (!proc.ai?.expose) throw new Error(`Tool '${name}' is not exposed to AI`);
    if (proc.ai.confirm) {
      if (!opts.approvals) {
        throw new Error(`Tool '${name}' needs approval; pass { approvals } to run it`);
      }
      const propose = proposers.get(opts.approvals as Approvals<never>);
      if (!propose) throw new Error("approvals must come from createApprovals()");
      return propose(proc, name, args, ctx);
    }
    // Streaming tools: collect the chunks into a single result (join strings,
    // else return the array) so a streaming procedure can be an LLM/MCP tool.
    // Validation runs first in both paths — the guardrail on model output.
    const site = { path: name, transport: "tool" as const };
    if (proc.kind === "stream") return collect(invokeStream(proc, args, ctx, site));
    return invokeUnary(proc, args, ctx, site);
  };
}
