// Connects to an external MCP server and exposes its tools to dendra as a
// `ToolSource`, ready to be merged into the assistant's toolset (mergeToolsets).
//
// The framework itself has no MCP *client* — it only needs the two-method
// `McpClientLike` shape, which the official SDK `Client` satisfies as-is. So the
// app owns the transport/connection (an app concern, like auth), and dendra owns
// the tool plumbing.
//
// Pick a transport with env vars (see .env.example):
//   EXTERNAL_MCP_URL   → a remote MCP server over Streamable HTTP
//                        (e.g. https://mcp.example.com/mcp)
//   EXTERNAL_MCP_CMD   → a local MCP server over stdio, the command to spawn
//                        (e.g. "npx -y @modelcontextprotocol/server-filesystem /tmp")
//   (neither set)      → the in-process demo server (always runnable, no setup)

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createMcpToolSource, type ToolFormat, type ToolSource } from "dendra";
import { createExternalMcpServer } from "./external-mcp-server.ts";

// Cache the connected client across hot reloads / requests (Next dev re-imports
// modules), like we do for the DB. One connection, reused.
const g = globalThis as unknown as { __dendraMcpClient?: Promise<Client> };

/** Build the client transport from env — remote HTTP, stdio, or the demo server. */
async function makeTransport(): Promise<Transport> {
  const url = process.env.EXTERNAL_MCP_URL;
  if (url) {
    // Any real remote MCP server (GitHub's, Linear's, your own …).
    return new StreamableHTTPClientTransport(new URL(url));
  }

  const cmd = process.env.EXTERNAL_MCP_CMD;
  if (cmd) {
    // Any stdio MCP server launched as a child process.
    const [command, ...args] = cmd.split(" ");
    return new StdioClientTransport({ command, args });
  }

  // Zero-config fallback: an in-process demo MCP server. The protocol handshake
  // is real; only the transport is local (no network, no credentials).
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createExternalMcpServer().connect(serverTransport);
  return clientTransport;
}

async function getConnectedClient(): Promise<Client> {
  if (!g.__dendraMcpClient) {
    g.__dendraMcpClient = (async () => {
      const transport = await makeTransport();
      const client = new Client(
        { name: "dendra-notes-app", version: "1.0.0" },
        { capabilities: {} },
      );
      await client.connect(transport);
      return client;
    })();
  }
  return g.__dendraMcpClient;
}

/**
 * The external MCP server's tools as a dendra ToolSource. Prefixed with "ext."
 * so they're visibly distinct from local procedures in the UI. Degrades to an
 * empty source if the server can't be reached — the assistant still works with
 * just the local tools.
 */
export async function getExternalToolSource(
  format: ToolFormat,
): Promise<ToolSource> {
  try {
    const client = await getConnectedClient();
    return await createMcpToolSource(client, { format, prefix: "ext." });
  } catch (e) {
    g.__dendraMcpClient = undefined; // allow a retry on the next request
    console.warn("[mcp-tools] external MCP unavailable:", (e as Error).message);
    return { tools: [], names: [], execute: async () => undefined };
  }
}

/** How the external MCP server is reached (for the UI). */
function transportLabel(): string {
  if (process.env.EXTERNAL_MCP_URL) return `HTTP · ${process.env.EXTERNAL_MCP_URL}`;
  if (process.env.EXTERNAL_MCP_CMD) return `stdio · ${process.env.EXTERNAL_MCP_CMD}`;
  return "in-process (demo)";
}

export interface ExternalMcpInfo {
  connected: boolean;
  /** Server name reported during the MCP handshake. */
  server: string;
  /** How we connected to it. */
  transport: string;
  /** The tools it exposes (dendra-side names, i.e. with the "ext." prefix). */
  tools: Array<{ name: string; description: string }>;
}

/** A UI-facing snapshot of the connected external MCP server + its tools. */
export async function getExternalMcpInfo(): Promise<ExternalMcpInfo> {
  const transport = transportLabel();
  try {
    const client = await getConnectedClient();
    const src = await createMcpToolSource(client, { format: "plain", prefix: "ext." });
    const serverInfo = client.getServerVersion?.();
    return {
      connected: true,
      server: serverInfo ? `${serverInfo.name} v${serverInfo.version}` : "unknown",
      transport,
      tools: (src.tools as Array<{ name: string; description: string }>).map((t) => ({
        name: t.name,
        description: t.description,
      })),
    };
  } catch {
    g.__dendraMcpClient = undefined;
    return { connected: false, server: "—", transport, tools: [] };
  }
}
