// Cross-tenant contract: an MCP connection for workspace A must not read or
// write workspace B, even though the same handlers serve MCP and RPC. Drives the
// real route handlers (app/api/mcp, app/rpc) in-process against a temp SQLite DB.

import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

process.chdir(mkdtempSync(join(tmpdir(), "dendra-tenancy-")));
process.env.MCP_TOKENS = "acme:alice:tok-acme,beta:bob:tok-beta";

type Route = (req: Request) => Promise<Response>;
let mcpPost: Route;
let rpcGet: Route;
let rpcPost: Route;
let register: Route;
let authorize: (req: Request) => Response | Promise<Response>;
let token: Route;

beforeAll(async () => {
  mcpPost = (await import("../app/api/mcp/route.ts")).POST;
  ({ GET: rpcGet, POST: rpcPost } = await import("../app/rpc/[...path]/route.ts"));
  register = (await import("../app/oauth/register/route.ts")).POST;
  authorize = (await import("../app/oauth/authorize/route.ts")).GET;
  token = (await import("../app/oauth/token/route.ts")).POST;
});

// The whole demo OAuth flow (register → authorize on a tenant's host → token)
// through the real routes, as an MCP client like claude.ai would run it.
async function oauthLogin(host: string): Promise<string> {
  const redirectUri = "http://127.0.0.1:9999/callback";
  const reg = await register(
    new Request(`http://${host}/oauth/register`, {
      method: "POST",
      headers: { host, "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [redirectUri] }),
    }),
  );
  const { client_id } = (await reg.json()) as { client_id: string };

  const verifier = "v".repeat(64);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const url = new URL(`http://${host}/oauth/authorize`);
  url.search = new URLSearchParams({
    client_id,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "s",
  }).toString();
  const auth = await authorize(new Request(url, { headers: { host } }));
  expect(auth.status).toBe(302);
  const code = new URL(auth.headers.get("location")!).searchParams.get("code")!;

  const tok = await token(
    new Request(`http://${host}/oauth/token`, {
      method: "POST",
      headers: { host, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
      }).toString(),
    }),
  );
  return ((await tok.json()) as { access_token: string }).access_token;
}

interface Note {
  id: string;
  tenantId: string;
  userId: string;
  title: string;
}

function headers(token?: string, extra: Record<string, string> = {}) {
  return {
    host: "localhost:3100",
    "content-type": "application/json",
    ...(token && { authorization: `Bearer ${token}` }),
    ...extra,
  };
}

async function mcp(token: string | undefined, method: string, params?: object, extra?: Record<string, string>) {
  return mcpPost(
    new Request("http://localhost:3100/api/mcp", {
      method: "POST",
      headers: headers(token, extra),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
  );
}

async function callTool(token: string, name: string, args: object = {}, extra?: Record<string, string>) {
  const res = await mcp(token, "tools/call", { name, arguments: args }, extra);
  expect(res.status).toBe(200);
  const { result } = (await res.json()) as {
    result: { isError?: boolean; content: Array<{ text: string }> };
  };
  return { isError: result.isError === true, text: result.content[0].text };
}

async function mcpList(token: string, extra?: Record<string, string>): Promise<Note[]> {
  const { isError, text } = await callTool(token, "notes_list", {}, extra);
  expect(isError).toBe(false);
  return JSON.parse(text);
}

async function rpcList(token: string, extra?: Record<string, string>): Promise<Note[]> {
  const res = await rpcGet(
    new Request("http://localhost:3100/rpc/notes.list", { headers: headers(token, extra) }),
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { result: Note[] }).result;
}

describe("tenant isolation across MCP and RPC", () => {
  let acmeNote: Note;

  beforeAll(async () => {
    const created = await callTool("tok-acme", "notes_create", {
      title: "acme secret",
      body: "only for acme",
    });
    expect(created.isError).toBe(false);
    acmeNote = JSON.parse(created.text);
  });

  it("stamps the note with the token's tenant and user", () => {
    expect(acmeNote).toMatchObject({ tenantId: "acme", userId: "alice" });
  });

  it("is visible to workspace A over MCP and RPC", async () => {
    expect((await mcpList("tok-acme")).map((n) => n.id)).toContain(acmeNote.id);
    expect((await rpcList("tok-acme")).map((n) => n.id)).toContain(acmeNote.id);
  });

  it("is invisible to workspace B over MCP and RPC", async () => {
    expect((await mcpList("tok-beta")).map((n) => n.id)).not.toContain(acmeNote.id);
    expect((await rpcList("tok-beta")).map((n) => n.id)).not.toContain(acmeNote.id);
  });

  it("can't be deleted by workspace B, even by id", async () => {
    const del = await callTool("tok-beta", "notes_delete", { id: acmeNote.id });
    expect(del.isError).toBe(true);
    expect((await mcpList("tok-acme")).map((n) => n.id)).toContain(acmeNote.id);
  });

  it("puts B's writes in B, not A", async () => {
    const created = await callTool("tok-beta", "notes_create", { title: "beta", body: "b" });
    const betaNote: Note = JSON.parse(created.text);
    expect(betaNote.tenantId).toBe("beta");
    expect((await mcpList("tok-acme")).map((n) => n.id)).not.toContain(betaNote.id);
  });

  it("ignores a spoofed x-tenant header or tenant subdomain", async () => {
    const spoof = { "x-tenant": "acme", "x-user": "alice", host: "acme.localhost:3100" };
    expect((await mcpList("tok-beta", spoof)).map((n) => n.id)).not.toContain(acmeNote.id);
    expect((await rpcList("tok-beta", spoof)).map((n) => n.id)).not.toContain(acmeNote.id);
    const created = await callTool("tok-beta", "notes_create", { title: "x", body: "x" }, spoof);
    expect(JSON.parse(created.text)).toMatchObject({ tenantId: "beta", userId: "bob" });
  });

  it("scopes an OAuth login to the workspace it was authorized on", async () => {
    const betaToken = await oauthLogin("beta.localhost:3100");
    expect((await mcpList(betaToken)).map((n) => n.id)).not.toContain(acmeNote.id);
    // …even when the MCP request itself is sent to acme's host.
    expect((await mcpList(betaToken, { host: "acme.localhost:3100" })).map((n) => n.id)).not.toContain(
      acmeNote.id,
    );
    const acmeToken = await oauthLogin("acme.localhost:3100");
    expect((await mcpList(acmeToken)).map((n) => n.id)).toContain(acmeNote.id);
  });

  it("rejects a missing or unknown token", async () => {
    expect((await mcp(undefined, "tools/list")).status).toBe(401);
    expect((await mcp("nope", "tools/list")).status).toBe(401);
    const res = await rpcPost(
      new Request("http://localhost:3100/rpc/notes.create", {
        method: "POST",
        headers: headers("nope"),
        body: JSON.stringify({ title: "x", body: "x" }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it("refuses to serve MCP on the old single MCP_TOKEN setting", async () => {
    const saved = process.env.MCP_TOKENS;
    delete process.env.MCP_TOKENS;
    process.env.MCP_TOKEN = "old-secret";
    try {
      for (const t of [undefined, "old-secret"]) {
        const res = await mcp(t, "tools/list");
        expect(res.status).toBe(500);
        expect(JSON.stringify(await res.json())).toContain("MCP_TOKENS");
      }
    } finally {
      delete process.env.MCP_TOKEN;
      process.env.MCP_TOKENS = saved;
    }
  });
});
