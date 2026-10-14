// Self-contained MCP connectors panel: lists connected servers, adds one (with
// the OAuth popup flow for servers that need it), and disconnects. Reports the
// live count up so the header can show it. UI-only — the actual connection
// management lives in server/mcp-tools.ts.

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import s from "../chat.module.css";

type McpServer = {
  id: string;
  server: string;
  transport: string;
  prefix: string;
  tools: Array<{ name: string; description: string }>;
};

export function Connectors({
  open,
  onCountChange,
}: {
  open: boolean;
  onCountChange?: (n: number) => void;
}) {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

  function refresh() {
    api.mcp
      .servers()
      .then((list) => {
        setServers(list);
        onCountChange?.(list.length);
      })
      .catch(() => {
        setServers([]);
        onCountChange?.(0);
      });
  }
  useEffect(refresh, []); // eslint-disable-line react-hooks/exhaustive-deps

  // An OAuth popup postMessages back here when it finishes.
  useEffect(() => {
    function onMsg(e: MessageEvent) {
      if (e.origin !== window.location.origin) return;
      const data = e.data as { type?: string; ok?: boolean };
      if (data?.type !== "mcp-oauth") return;
      setNote("");
      if (data.ok) {
        setUrl("");
        setName("");
        setError("");
      } else {
        setError("Authorization failed or was denied.");
      }
      refresh();
    }
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function connect() {
    const u = url.trim();
    if (!u || connecting) return;
    setConnecting(true);
    setError("");
    setNote("");
    try {
      const res = await api.mcp.connect({ url: u, name: name.trim() || undefined });
      if (res.status === "auth_required") {
        setNote("Complete sign-in in the popup to finish connecting…");
        window.open(res.authorizeUrl, "mcp-oauth", "width=520,height=720");
      } else {
        setUrl("");
        setName("");
        refresh();
      }
    } catch (e) {
      setError((e as Error).message || "Could not connect");
    } finally {
      setConnecting(false);
    }
  }

  async function disconnect(id: string) {
    try {
      await api.mcp.disconnect({ id });
    } finally {
      refresh();
    }
  }

  if (!open) return null;

  return (
    <div className={s.connectors}>
      <div className={s.connForm}>
        <input
          className={s.connInput}
          style={{ flex: 2, minWidth: 200 }}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && connect()}
          placeholder="https://your-mcp-server.com/mcp"
        />
        <input
          className={s.connInput}
          style={{ flex: 1, minWidth: 120 }}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && connect()}
          placeholder="name (optional)"
        />
        <button className={s.connBtn} onClick={connect} disabled={connecting}>
          {connecting ? "…" : "Connect"}
        </button>
      </div>
      {note && <div className={s.note}>🔐 {note}</div>}
      {error && <div className={s.err}>⚠️ {error}</div>}

      {servers.map((srv) => (
        <div key={srv.id} className={s.srvRow}>
          <div className={s.srvHead}>
            <strong style={{ fontSize: 13 }}>{srv.server}</strong>
            <span className={s.srvMeta}>{srv.transport}</span>
            {srv.id !== "default" && (
              <button
                className={s.xBtn}
                title="Disconnect"
                onClick={() => disconnect(srv.id)}
              >
                ✕
              </button>
            )}
          </div>
          <div className={s.toolTags}>
            {srv.tools.length === 0 && <span className={s.muted}>no tools</span>}
            {srv.tools.map((t) => (
              <span key={t.name} className={s.toolTag} title={t.description}>
                🔌 {t.name}
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
