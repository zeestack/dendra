# {{projectName}}

A Next.js app built on [dendra](https://github.com/zeestack/dendra) where every
`.ai()` procedure is a typed client method, an RPC call, **and** a tool Claude can
call over MCP — from one definition.

## Run

```bash
npm run dev   # http://localhost:3000
```

The home page shows your RPC client working and lists the tools your MCP endpoint
exposes (the same ones Claude would see).

## Where things are

- `server/router.ts` — your procedures; `.ai({ description })` marks one as an LLM/MCP tool
- `app/api/mcp/route.ts` — remote MCP endpoint (for claude.ai), at `/api/mcp`
- `mcp-server.ts` — stdio MCP server (for Claude Desktop), run with `npm run mcp:stdio`
- `lib/api.ts` — the typed client (inferred from the router, no codegen)

## Connect Claude

### Claude Desktop (stdio) — recommended for local

**1.** Install deps (if you haven't): `npm install`

**2.** Open your Claude Desktop config file:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
  ```bash
  open -e "$HOME/Library/Application Support/Claude/claude_desktop_config.json"
  ```
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

(Create it if it doesn't exist.)

**3.** Add this server inside `mcpServers` — replace the path with this project's
**absolute path** (run `pwd` in this folder to get it):

```json
{
  "mcpServers": {
    "{{projectName}}": {
      "command": "npm",
      "args": ["--prefix", "/ABSOLUTE/PATH/TO/{{projectName}}", "run", "--silent", "mcp:stdio"]
    }
  }
}
```

> Why `--prefix` and `--silent`? Claude Desktop launches servers from `/`, so
> without `--prefix` npm can't find `package.json` (ENOENT); `--silent` keeps
> npm's banner out of the MCP stdout stream. Windows: use `\\` in the path.

**4.** Fully quit Claude Desktop (**Cmd+Q** / Exit — not just closing the window)
and reopen it.

**5.** In a new chat, click the connector/tools icon (🔌) — you should see
**{{projectName}}** with `add`, `notes_list`, `notes_create`. Then try:

> create a note titled Groceries with body "milk, eggs"

Claude calls your `notes.create` tool. Then ask: *"list my notes"*.

### claude.ai (remote HTTP)

**1.** `npm run dev` (serves the MCP endpoint at `/api/mcp`).

**2.** Expose `http://localhost:3000/api/mcp` publicly over HTTPS — e.g. a tunnel:
```bash
npx cloudflared tunnel --url http://localhost:3000
```

**3.** In claude.ai → **Settings → Connectors → Add custom connector**, paste the
tunnel's `https://…/api/mcp` URL.

> The endpoint is **open** for local dev — add auth (a bearer token or OAuth)
> before exposing it beyond your machine.

### Troubleshooting

- `ENOENT /package.json` → you omitted `--prefix` (the absolute project path).
- Tools don't appear → you didn't fully quit Claude Desktop (Cmd+Q), or the JSON
  has a syntax error (a stray comma). Check the config is valid JSON.
- Garbled / no response → something printed to stdout. Keep `--silent`; the server
  logs only to stderr.

## From here

- Add more `.ai()` procedures — they show up as tools automatically.
- Give a procedure a path (`.get`/`.post`) + mount the REST adapter for REST + OpenAPI.

Docs: https://products.techfoundry.io/dendra
