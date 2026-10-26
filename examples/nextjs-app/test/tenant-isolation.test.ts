// Cross-tenant contract: an MCP connection for workspace A must not read or
// write workspace B, even though the same handlers serve MCP and RPC. Drives the
// real route handlers (app/api/mcp, app/rpc) in-process against a temp SQLite DB.

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
let oauth: typeof import("../server/oauth-store.ts").oauth;

beforeAll(async () => {
  mcpPost = (await import("../app/api/mcp/route.ts")).POST;
  ({ GET: rpcGet, POST: rpcPost } = await import("../app/rpc/[...path]/route.ts"));
  ({ oauth } = await import("../server/oauth-store.ts"));
});

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

  it("scopes an OAuth token to the workspace it was issued for", async () => {
    const { token } = oauth.issueToken("client_test", "carol", "beta");
    expect((await mcpList(token)).map((n) => n.id)).not.toContain(acmeNote.id);
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
});
