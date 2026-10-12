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

### Claude Desktop (stdio)

Run `npm install` first. Then add this to your Claude Desktop MCP config and fully
quit + reopen Claude Desktop. Use `--prefix` with this project's **absolute path**
— Claude Desktop launches servers from `/`, so without it npm can't find
`package.json`; `--silent` keeps npm's banner out of the MCP stream:

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

Ask Claude: "create a note titled Groceries with body milk, eggs" — it'll call
your `notes.create` tool.

### claude.ai (remote HTTP)

Run `npm run dev`, expose `http://localhost:3000/api/mcp` (e.g. via a tunnel), and
add it as a custom connector. The endpoint is open for local dev — add auth (a
bearer token or OAuth) before exposing it publicly.

## From here

- Add more `.ai()` procedures — they show up as tools automatically.
- Give a procedure a path (`.get`/`.post`) + mount the REST adapter for REST + OpenAPI.

Docs: https://products.techfoundry.io/dendra
