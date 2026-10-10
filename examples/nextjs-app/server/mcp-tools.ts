// Connects to external MCP servers and exposes their tools to dendra as
// `ToolSource`s, merged into the assistant's toolset (mergeToolsets).
//
// The framework has no MCP *client* — it only needs the two-method
// `McpClientLike` shape, which the official SDK `Client` satisfies. So the app
// owns connections (transport, lifecycle) and dendra owns the tool plumbing.
//
// Connections are a runtime REGISTRY: one default server is seeded from env (or
// the in-process demo), and the UI can add/remove more at runtime via a button
// (see mcp.connect / mcp.disconnect in server/router.ts).

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createMcpToolSource, type ToolFormat, type ToolSource } from "dendra";
import { createExternalMcpServer } from "./external-mcp-server.ts";
import { AppOAuthProvider, authStore, type PendingAuth } from "./mcp-oauth.ts";

interface Connection {
  id: string;
  prefix: string;
  transport: string; // human label of how we connected
  server: string; // name + version from the MCP handshake
  client: Client;
}

// Survive Next dev's module re-imports (like the DB cache).
const g = globalThis as unknown as {
  __dendraMcp?: { conns: Map<string, Connection>; seeded?: Promise<void> };
};
function store() {
  if (!g.__dendraMcp) g.__dendraMcp = { conns: new Map() };
  return g.__dendraMcp;
}

async function newClient(transport: Transport): Promise<Client> {
  const client = new Client(
    { name: "dendra-notes-app", version: "1.0.0" },
    { capabilities: {} },
  );
  await client.connect(transport);
  return client;
}

/** Build the default connection from env — remote HTTP, stdio, or the demo. */
async function defaultTransport(): Promise<{ transport: Transport; label: string }> {
  const url = process.env.EXTERNAL_MCP_URL;
  if (url) {
    return {
      transport: new StreamableHTTPClientTransport(new URL(url)),
      label: `HTTP · ${url}`,
    };
  }
  const cmd = process.env.EXTERNAL_MCP_CMD;
  if (cmd) {
    const [command, ...args] = cmd.split(" ");
    return { transport: new StdioClientTransport({ command, args }), label: `stdio · ${cmd}` };
  }
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createExternalMcpServer().connect(serverTransport);
  return { transport: clientTransport, label: "in-process (demo)" };
}

/** Seed the default server once (keeps the "ext." prefix so demo cards match). */
async function ensureSeeded(): Promise<void> {
  const s = store();
  if (!s.seeded) {
    s.seeded = (async () => {
      try {
        const { transport, label } = await defaultTransport();
        const client = await newClient(transport);
        const info = client.getServerVersion?.();
        s.conns.set("default", {
          id: "default",
          prefix: "ext.",
          transport: label,
          server: info ? `${info.name} v${info.version}` : "unknown",
          client,
        });
      } catch (e) {
        console.warn("[mcp-tools] default MCP unavailable:", (e as Error).message);
      }
    })();
  }
  await s.seeded;
}

// ── Public API used by the router ───────────────────────────────────────────

export interface McpServerInfo {
  id: string;
  server: string;
  transport: string;
  prefix: string;
  tools: Array<{ name: string; description: string }>;
}

/** A tool source per connected server (for the assistant to merge). */
export async function getExternalToolSources(format: ToolFormat): Promise<ToolSource[]> {
  await ensureSeeded();
  const out: ToolSource[] = [];
  for (const conn of store().conns.values()) {
    try {
      out.push(await createMcpToolSource(conn.client, { format, prefix: conn.prefix }));
    } catch (e) {
      console.warn(`[mcp-tools] ${conn.id} list failed:`, (e as Error).message);
    }
  }
  return out;
}

/** UI snapshot: every connected server and the tools it exposes. */
export async function listMcpServers(): Promise<McpServerInfo[]> {
  await ensureSeeded();
  const out: McpServerInfo[] = [];
  for (const conn of store().conns.values()) {
    let tools: McpServerInfo["tools"] = [];
    try {
      const src = await createMcpToolSource(conn.client, { format: "plain", prefix: conn.prefix });
      tools = (src.tools as McpServerInfo["tools"]).map((t) => ({
        name: t.name,
        description: t.description,
      }));
    } catch {
      /* leave tools empty if the server is unreachable */
    }
    out.push({ id: conn.id, server: conn.server, transport: conn.transport, prefix: conn.prefix, tools });
  }
  return out;
}

export type ConnectResult =
  | { status: "connected"; server: McpServerInfo }
  | { status: "auth_required"; id: string; authorizeUrl: string };

/**
 * Connect a new remote MCP server by URL (Streamable HTTP). If the server needs
 * OAuth, returns { status: "auth_required", authorizeUrl } — the browser opens
 * that URL; after the user approves, /mcp/callback calls finishMcpAuth().
 */
export async function connectMcpServer(input: {
  url: string;
  name?: string;
  /** App origin (from ctx) — used to build the OAuth redirect URI. */
  origin: string;
}): Promise<ConnectResult> {
  await ensureSeeded();
  const s = store();

  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    throw new Error("Enter a valid URL (e.g. https://host/mcp)");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http(s) MCP servers can be connected from the UI");
  }

  // id + prefix from the given name or the host; keep them unique.
  const base = (input.name?.trim() || url.hostname).replace(/[^a-zA-Z0-9]+/g, "_");
  let id = base;
  for (let i = 2; s.conns.has(id) || authStore().has(id); i++) id = `${base}_${i}`;
  const prefix = `${id}.`;

  // Register a pending auth up front; the OAuth provider reads/writes it. If the
  // server needs no auth, the handshake just succeeds and we discard it.
  const pending: PendingAuth = {
    id,
    url: url.toString(),
    name: input.name,
    prefix,
    redirectUri: `${input.origin}/mcp/callback`,
    createdAt: Date.now(),
  };
  authStore().set(id, pending);

  const transport = new StreamableHTTPClientTransport(url, {
    authProvider: new AppOAuthProvider(pending),
  });

  try {
    const client = await newClient(transport);
    authStore().delete(id); // no auth needed
    return { status: "connected", server: await register(id, prefix, url, client) };
  } catch (e) {
    if (e instanceof UnauthorizedError && pending.authorizeUrl) {
      // The browser must send the user here to authorize.
      return { status: "auth_required", id, authorizeUrl: pending.authorizeUrl };
    }
    authStore().delete(id);
    throw e;
  }
}

/**
 * Complete an OAuth connection after the user is redirected back with a code.
 * Exchanges the code for tokens (via the same provider state), finishes the MCP
 * handshake, and registers the connection.
 */
export async function finishMcpAuth(state: string, code: string): Promise<McpServerInfo> {
  const pending = authStore().get(state);
  if (!pending) throw new Error("Unknown or expired authorization request");

  const url = new URL(pending.url);
  const provider = new AppOAuthProvider(pending);
  const transport = new StreamableHTTPClientTransport(url, { authProvider: provider });

  await transport.finishAuth(code); // code → tokens (saved on `pending`)
  const client = await newClient(transport); // retry handshake, now authorized

  const info = await register(pending.id, pending.prefix, url, client);
  authStore().delete(state);
  return info;
}

/** Add a connected client to the registry and return its UI snapshot. */
async function register(
  id: string,
  prefix: string,
  url: URL,
  client: Client,
): Promise<McpServerInfo> {
  const v = client.getServerVersion?.();
  const conn: Connection = {
    id,
    prefix,
    transport: `HTTP · ${url.host}`,
    server: v ? `${v.name} v${v.version}` : "unknown",
    client,
  };
  store().conns.set(id, conn);

  const src = await createMcpToolSource(client, { format: "plain", prefix });
  return {
    id,
    server: conn.server,
    transport: conn.transport,
    prefix,
    tools: (src.tools as McpServerInfo["tools"]).map((t) => ({
      name: t.name,
      description: t.description,
    })),
  };
}

/** Disconnect and remove a server (the seeded default can't be removed). */
export async function disconnectMcpServer(id: string): Promise<void> {
  if (id === "default") throw new Error("The default server can't be disconnected");
  const conn = store().conns.get(id);
  if (!conn) return;
  try {
    await conn.client.close();
  } catch {
    /* ignore close errors */
  }
  store().conns.delete(id);
}
