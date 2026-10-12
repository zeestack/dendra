# create-dendra-app

Scaffold a Next.js app built on [dendra](https://github.com/zeestack/dendra) —
typed RPC/REST where every procedure can also be an LLM tool and an MCP server.

```bash
npm create dendra-app@latest my-app
# or: pnpm create dendra-app my-app · yarn create dendra-app my-app · bun create dendra-app my-app
```

Then:

```bash
cd my-app
npm run dev   # http://localhost:3000
```

## Options

```
npm create dendra-app@latest [dir] [options]

  -t, --template <name>   minimal | mcp        (default: minimal)
      --pm <manager>      npm | pnpm | yarn | bun   (default: auto-detect)
      --no-install        skip dependency install
      --no-git            skip git init
  -y, --yes               accept defaults, no prompts
  -h, --help              show help
```

## Templates

- **minimal** — the define → serve → call core: a router, the Next.js RPC handler,
  and a typed client (type inferred, no codegen). The smallest thing that shows
  the idea.
- **mcp** — minimal plus `.ai()` tools, an MCP route, and a stdio MCP server, so
  your API is callable by Claude.

Zero-config, near-zero dependencies. Requires Node 18+.

Docs: https://products.techfoundry.io/dendra
