// MCP bridge. The Model Context Protocol is, at its core, `tools/list` +
// `tools/call` — which is exactly what we already have: `toToolset` produces the
// schemas, and the tool executor runs them with validation. So this file is a
// thin, zero-dependency shaping layer; the example wires it to the official MCP
// SDK transport (stdio / HTTP). Only `.ai()`-exposed procedures are surfaced.

import { createToolExecutor, formatTool, toToolset } from "./tools.ts";
import type { ToolFormat, ToolSource } from "./tools.ts";
import type { JSONSchema } from "./schema.ts";
import { resolveProc, type RouterRecord } from "./core.ts";
import type { Approvals } from "./approvals.ts";

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Set for `.get()` reads and `.ai({ confirm: true })` tools. */
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}

export interface McpCallResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/** MCP `tools/list` payload derived from the router's `.ai()` procedures. */
export function mcpToolDefinitions(router: object): McpToolDef[] {
  return (toToolset(router, { format: "plain" }) as McpToolDef[]).map((def) => {
    const proc = resolveProc(router as RouterRecord, def.name.split("."));
    // A read can't change anything; a confirm tool is one a person must approve.
    if (proc?.method === "GET") return { ...def, annotations: { readOnlyHint: true } };
    if (proc?.ai?.confirm) {
      return { ...def, annotations: { readOnlyHint: false, destructiveHint: true } };
    }
    return def;
  });
}

/**
 * In-process bridge: list + call tools against the router directly (own data).
 * For calling a *running* app instead, see the example's HTTP-proxy server.
 */
export function createMcpBridge<Ctx>(
  router: object,
  ctx: Ctx,
  opts: { approvals?: Approvals<Ctx> } = {},
) {
  const execute = createToolExecutor(router, ctx, opts);
  return {
    listTools(): McpToolDef[] {
      return mcpToolDefinitions(router);
    },
    async callTool(name: string, args: unknown): Promise<McpCallResult> {
      try {
        const result = await execute(name, args ?? {});
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (e) {
        return {
          content: [{ type: "text", text: (e as Error).message }],
          isError: true,
        };
      }
    },
  };
}

// ── Consuming external MCP servers (the other direction) ────────────────────
// Everything above turns *your* procedures into MCP tools. This turns *someone
// else's* MCP server into a dendra `ToolSource`, so remote tools can be merged
// into the same toolset your model already uses (see `mergeToolsets`). The
// framework stays zero-dependency: you pass any object shaped like an MCP client
// (the official `@modelcontextprotocol/sdk` `Client` fits as-is), and dendra
// only speaks the two methods it needs.

/** The minimal surface dendra needs from an MCP client (structural; the SDK's `Client` matches). */
export interface McpClientLike {
  listTools(): Promise<{
    tools: Array<{
      name: string;
      description?: string;
      inputSchema?: Record<string, unknown>;
    }>;
  }>;
  callTool(params: {
    name: string;
    arguments?: Record<string, unknown>;
  }): Promise<{
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
    // Tolerate extra fields (and avoid a weak-type mismatch with SDK clients
    // whose result union carries additional/compat shapes).
    [key: string]: unknown;
  }>;
}

export interface McpToolSourceOptions {
  /** LLM provider format for the produced schemas (default: "anthropic"). */
  format?: ToolFormat;
  /** Keep only tools whose name passes this predicate. */
  filter?: (name: string) => boolean;
  /**
   * Prefix added to each remote tool name on the dendra side (e.g. "gh.") to
   * avoid collisions with local tools. Stripped before the call reaches the
   * server, so the remote never sees the prefix.
   */
  prefix?: string;
}

/**
 * Connect an already-connected MCP client as a dendra `ToolSource`: lists the
 * server's tools once, exposes them in your chosen format, and routes each call
 * back over `tools/call`. JSON text results are parsed to structured data; an
 * MCP `isError` result is thrown so it flows through dendra's normal error path.
 */
export async function createMcpToolSource(
  client: McpClientLike,
  opts: McpToolSourceOptions = {},
): Promise<ToolSource> {
  const format = opts.format ?? "anthropic";
  const listed = (await client.listTools()).tools.filter(
    (t) => !opts.filter || opts.filter(t.name),
  );
  // Map the dendra-side (possibly prefixed) name back to the remote name.
  const remoteName = new Map<string, string>();
  const tools = listed.map((t) => {
    const localName = opts.prefix ? `${opts.prefix}${t.name}` : t.name;
    remoteName.set(localName, t.name);
    const schema = (t.inputSchema as JSONSchema) ?? {
      type: "object",
      properties: {},
    };
    return formatTool(localName, t.description ?? localName, schema, format);
  });
  return {
    tools,
    names: [...remoteName.keys()],
    async execute(name, args) {
      const remote = remoteName.get(name);
      if (!remote) throw new Error(`Tool '${name}' is not in this MCP source`);
      const res = await client.callTool({
        name: remote,
        arguments: (args as Record<string, unknown>) ?? {},
      });
      const text = (res.content ?? [])
        .filter((c) => c.type === "text" && typeof c.text === "string")
        .map((c) => c.text as string)
        .join("");
      if (res.isError) throw new Error(text || `MCP tool '${remote}' failed`);
      try {
        return JSON.parse(text);
      } catch {
        return text; // not JSON — return the raw text
      }
    },
  };
}
