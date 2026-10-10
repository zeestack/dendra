// OAuth redirect target for connecting to protected MCP servers. The remote
// authorization server sends the user here with ?code & ?state after they
// approve. We exchange the code for tokens, finish the MCP handshake, then close
// the popup and tell the opener (the assistant page) to refresh its connectors.

import { finishMcpAuth } from "@/server/mcp-tools";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function page(ok: boolean, message: string): Response {
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>MCP connection</title>
<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;color:#333}
.box{text-align:center;max-width:420px;padding:24px}</style></head>
<body><div class="box">
<h2>${ok ? "✅ Connected" : "⚠️ Connection failed"}</h2>
<p>${message}</p>
<p style="color:#888;font-size:13px">You can close this window.</p>
</div>
<script>
  try { window.opener && window.opener.postMessage(
    { type: "mcp-oauth", ok: ${ok ? "true" : "false"} }, window.location.origin); } catch (e) {}
  setTimeout(function(){ try { window.close(); } catch (e) {} }, ${ok ? 1200 : 4000});
</script>
</body></html>`;
  return new Response(html, {
    status: ok ? 200 : 400,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    return page(false, `Authorization was denied (${error}).`);
  }
  if (!code || !state) {
    return page(false, "Missing authorization code or state.");
  }
  try {
    const info = await finishMcpAuth(state, code);
    return page(true, `Connected to ${info.server} — ${info.tools.length} tool(s) available.`);
  } catch (e) {
    return page(false, (e as Error).message);
  }
}
