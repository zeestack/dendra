"use client";

// "Connect Claude" — how to point Claude Desktop or claude.ai at THIS app's MCP
// server. The app exposes its .ai() procedures as MCP tools two ways: a remote
// HTTP endpoint (/api/mcp) and a stdio server (mcp-server.ts).

import { useEffect, useState } from "react";
import u from "../ui.module.css";

type Tool = { name: string; description: string };

const DESKTOP_CONFIG = `{
  "mcpServers": {
    "dendra-example": {
      "command": "npm",
      "args": [
        "--prefix", "/ABSOLUTE/PATH/TO/examples/nextjs-app",
        "run", "--silent", "mcp:stdio"
      ]
    }
  }
}`;

export default function ConnectPage() {
  const [tools, setTools] = useState<Tool[] | null>(null);

  useEffect(() => {
    // Ask our own MCP endpoint what tools it exposes (exactly what Claude sees).
    fetch("/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    })
      .then((r) => r.json())
      .then((j) => setTools(j?.result?.tools ?? []))
      .catch(() => setTools([]));
  }, []);

  return (
    <main className={u.page}>
      <div className={u.hero}>
        <h1 className={u.h1}>Connect Claude</h1>
        <p className={u.lead}>
          This app is also an <strong>MCP server</strong>: every{" "}
          <span className={u.mono}>.ai()</span> procedure in the router is exposed
          as a tool Claude can call — same definition, no extra work. Point Claude
          Desktop or claude.ai at it and your notes, memory, and other tools become
          Claude&apos;s tools.
        </p>
      </div>

      {/* Live tool list */}
      <div className={u.card}>
        <div className={u.cardTitle}>🔌 Tools this app exposes</div>
        <p className={u.note}>
          Live from <span className={u.mono}>/api/mcp</span> — the exact set Claude
          will see.
        </p>
        {tools === null ? (
          <div className={u.muted}>Loading…</div>
        ) : tools.length === 0 ? (
          <div className={u.muted}>
            None reachable (is the app running? the endpoint may require auth).
          </div>
        ) : (
          <ul className={u.list}>
            {tools.map((t) => (
              <li key={t.name} className={u.listRow}>
                <span style={{ flex: 1 }}>
                  <code>{t.name}</code>
                  <span className={u.muted}> — {t.description}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Claude Desktop (stdio) */}
      <div className={u.card}>
        <div className={u.cardTitle}>Claude Desktop (stdio) — recommended locally</div>
        <ol style={{ lineHeight: 1.7, paddingLeft: 20, margin: "4px 0 0" }}>
          <li>
            Run the app: <span className={u.mono}>npm run dev</span> (the stdio
            server proxies to it on port 3100).
          </li>
          <li>
            Open your Claude Desktop config:
            <br />
            macOS:{" "}
            <span className={u.mono}>
              ~/Library/Application Support/Claude/claude_desktop_config.json
            </span>
            <br />
            Windows: <span className={u.mono}>%APPDATA%\Claude\claude_desktop_config.json</span>
          </li>
          <li>
            Add this server — replace the path with this folder&apos;s{" "}
            <strong>absolute path</strong> (run <span className={u.mono}>pwd</span>{" "}
            here):
            <pre className={u.pre}>{DESKTOP_CONFIG}</pre>
          </li>
          <li>
            Fully quit Claude Desktop (<strong>Cmd+Q</strong> / Exit) and reopen.
          </li>
          <li>
            In a new chat, click the connector icon (🔌) — you should see{" "}
            <strong>dendra-example</strong>. Try: <em>&ldquo;show my notes&rdquo;</em>{" "}
            or <em>&ldquo;create a note titled Groceries&rdquo;</em>.
          </li>
        </ol>
        <p className={u.note} style={{ marginTop: 12 }}>
          <span className={u.mono}>--prefix</span> makes npm find the project
          (Claude launches servers from <span className={u.mono}>/</span>);{" "}
          <span className={u.mono}>--silent</span> keeps npm&apos;s banner out of
          the MCP stdout stream.
        </p>
      </div>

      {/* claude.ai (remote) */}
      <div className={u.card}>
        <div className={u.cardTitle}>claude.ai (remote HTTP)</div>
        <ol style={{ lineHeight: 1.7, paddingLeft: 20, margin: "4px 0 0" }}>
          <li>
            Run the app: <span className={u.mono}>npm run dev</span> (serves MCP at{" "}
            <span className={u.mono}>/api/mcp</span>).
          </li>
          <li>
            Expose it over public HTTPS — e.g. a tunnel:
            <pre className={u.pre}>npx cloudflared tunnel --url http://localhost:3100</pre>
          </li>
          <li>
            In claude.ai → <strong>Settings → Connectors → Add custom connector</strong>,
            paste the tunnel&apos;s <span className={u.mono}>https://…/api/mcp</span> URL.
          </li>
        </ol>
        <p className={u.note} style={{ marginTop: 12 }}>
          The endpoint is open for local dev. Set{" "}
          <span className={u.mono}>MCP_TOKENS</span> (a bearer token per
          workspace) or use the built-in OAuth before exposing it beyond your
          machine.
        </p>
      </div>
    </main>
  );
}
