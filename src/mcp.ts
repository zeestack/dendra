// MCP bridge. The Model Context Protocol is, at its core, `tools/list` +
// `tools/call` — which is exactly what we already have: `toToolset` produces the
// schemas, and the tool executor runs them with validation. So this file is a
// thin, zero-dependency shaping layer; the example wires it to the official MCP
// SDK transport (stdio / HTTP). Only `.ai()`-exposed procedures are surfaced.

import { createToolExecutor, formatTool, toToolset, untilAborted } from "./tools.ts";
import type { ToolFormat, ToolSource } from "./tools.ts";
import type { JSONSchema } from "./schema.ts";
import { initDendra, resolveProc, type AnyProc, type RouterRecord } from "./core.ts";
import type { Approvals } from "./approvals.ts";
import { DendraError, publicError } from "./errors.ts";

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
    /** `signal` cancels the call (the MCP SDK passes one to each request handler). */
    async callTool(
      name: string,
      args: unknown,
      call: { signal?: AbortSignal } = {},
    ): Promise<McpCallResult> {
      try {
        const result = await execute(name, args ?? {}, call);
        // `undefined` isn't JSON (and `text` must be a string): send `null`.
        return { content: [{ type: "text", text: JSON.stringify(result ?? null) }] };
      } catch (e) {
        // Cancelled: the client isn't waiting for a result (the SDK drops it).
        if (call.signal?.aborted) throw e;
        // Unexpected errors are masked (their text can carry internals) and logged.
        if (!(e instanceof DendraError)) console.error(`[dendra] mcp: tool '${name}' failed:`, e);
        return { content: [{ type: "text", text: publicError(e).message }], isError: true };
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
  /** Cut remote descriptions to this many characters (default 1,024). */
  maxDescriptionLength?: number;
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
    const description = capDescription(t.description ?? localName, opts.maxDescriptionLength);
    return formatTool(localName, description, schema, format);
  });
  return {
    tools,
    names: [...remoteName.keys()],
    async execute(name, args, call = {}) {
      call.signal?.throwIfAborted();
      const remote = remoteName.get(name);
      if (!remote) throw new DendraError("NOT_FOUND", `Tool '${name}' not found`);
      return untilAborted(callRemote(client, remote, args), call.signal);
    },
  };
}

// A remote description is text the server wrote for the model: untrusted, and
// it costs context on every turn. Keep it to a bounded length.
const DEFAULT_MAX_DESCRIPTION = 1024;
function capDescription(text: string, max = DEFAULT_MAX_DESCRIPTION): string {
  return text.length <= max ? text : text.slice(0, max - 1) + "…";
}

// Call a remote tool. JSON text results are parsed to structured data; an MCP
// `isError` result becomes BAD_GATEWAY with the server's text (written for the
// model, so it passes through). The MCP SDK's callTool takes a signal in a
// different place in v1 and v2, so the remote call itself isn't cancelled.
async function callRemote(client: McpClientLike, name: string, args: unknown): Promise<unknown> {
  const res = await client.callTool({ name, arguments: (args as Record<string, unknown>) ?? {} });
  const text = (res.content ?? [])
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("");
  if (res.isError) throw new DendraError("BAD_GATEWAY", text || `MCP tool '${name}' failed`);
  try {
    return JSON.parse(text);
  } catch {
    return text; // not JSON — return the raw text
  }
}

export interface McpRouterOptions {
  /** Keep only tools whose (remote) name passes this predicate. */
  filter?: (name: string) => boolean;
  /**
   * Which tools need a person's approval before they run: `true` for all, or a
   * predicate on the remote name. Needs `createApprovals` over the router the
   * tools are mounted in, passed to the tool executor.
   */
  confirm?: boolean | ((name: string) => boolean);
  /** Cut remote descriptions to this many characters (default 1,024). */
  maxDescriptionLength?: number;
  /**
   * The route builder to define the tools from, e.g. one with your `.use()`
   * guards and `.after()` audit hook. Default: a plain `initDendra().route`.
   */
  route?: { input(schema: unknown): unknown };
}

/**
 * An external MCP server's tools as dendra procedures, to mount in your router
 * (`{ ...appRouter, gh: await createMcpRouter(client) }`). They're `.ai()`
 * tools like your own: guards and after-hooks run, `confirm` sends calls
 * through `createApprovals`, and `inspectRouter` lists them (`meta.mcp.tool` is
 * the server's name). A dotted remote name nests (`issues.create` →
 * `gh.issues.create`). Lists the server's tools once, when called.
 */
export async function createMcpRouter(
  client: McpClientLike,
  opts: McpRouterOptions = {},
): Promise<RouterRecord> {
  const route = (opts.route ?? initDendra().route) as RemoteBuilder;
  const router: RouterRecord = {};
  for (const t of (await client.listTools()).tools) {
    if (opts.filter && !opts.filter(t.name)) continue;
    const segments = t.name.split(".");
    if (segments.some((seg) => seg === "")) {
      throw new Error(`createMcpRouter: can't mount tool '${t.name}' (empty name segment)`);
    }
    const confirm = typeof opts.confirm === "function" ? opts.confirm(t.name) : opts.confirm === true;
    const proc = route
      .input(remoteInput(t.inputSchema))
      .ai({ description: capDescription(t.description ?? t.name, opts.maxDescriptionLength), confirm })
      .meta({ mcp: { tool: t.name } })
      .handler(({ input }) => callRemote(client, t.name, input));
    let node = router;
    for (const seg of segments.slice(0, -1)) {
      const next = node[seg];
      if (next !== undefined && isProc(next)) {
        throw new Error(`createMcpRouter: tool '${t.name}' is under '${seg}', which is also a tool`);
      }
      node = (node[seg] ??= {}) as RouterRecord;
    }
    const leaf = segments[segments.length - 1];
    if (node[leaf] !== undefined) {
      throw new Error(`createMcpRouter: tool '${t.name}' is also a namespace of other tools`);
    }
    node[leaf] = proc;
  }
  return router;
}

// Just the builder calls createMcpRouter makes, whatever the app's Ctx/Meta.
interface RemoteBuilder {
  input(schema: unknown): RemoteBuilder;
  ai(cfg: { description: string; confirm: boolean }): RemoteBuilder;
  meta(meta: { mcp: { tool: string } }): RemoteBuilder;
  handler(fn: (o: { input: unknown }) => Promise<unknown>): AnyProc;
}

const isProc = (v: unknown): v is AnyProc =>
  typeof v === "object" && v !== null && (v as { _dendra?: unknown })._dendra === true;

// The server validates its own input; here we only require an object, and
// publish the server's JSON Schema to the model and OpenAPI.
function remoteInput(inputSchema: Record<string, unknown> | undefined) {
  return {
    jsonSchema: (inputSchema as JSONSchema) ?? { type: "object", properties: {} },
    "~standard": {
      version: 1 as const,
      vendor: "mcp",
      validate: (value: unknown) =>
        typeof value === "object" && value !== null && !Array.isArray(value)
          ? { value: value as Record<string, unknown> }
          : { issues: [{ message: "Expected an object" }] },
    },
  };
}
