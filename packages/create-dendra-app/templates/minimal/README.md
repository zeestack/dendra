# {{projectName}}

A Next.js app built on [dendra](https://github.com/zeestack/dendra) — typed
RPC/REST where every procedure can also become an LLM tool and an MCP server.

## Run

```bash
npm run dev   # http://localhost:3000
```

## Where things are

- `server/router.ts` — your procedures (the single source of truth)
- `server/context.ts` — per-request context (auth/db live here, not in the framework)
- `app/rpc/[...path]/route.ts` — mounts the RPC/REST handler
- `lib/api.ts` — the typed client (type inferred from the router, no codegen)
- `app/page.tsx` — a page calling the typed client

## From here

- Give a procedure a path with `.get("/x")` / `.post("/x")` → it's also a REST
  endpoint and an OpenAPI operation.
- Add `.ai({ description })` → it's also a tool an LLM / Claude can call over MCP.
- Want the full AI/MCP + chat demo? Scaffold the `mcp` template:
  ```bash
  npm create dendra-app@latest my-ai-app -- --template mcp
  ```

Docs: https://products.techfoundry.io/dendra
