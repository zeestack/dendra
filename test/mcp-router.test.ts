import { describe, it, expect } from "vitest";
import {
  initDendra,
  createMcpRouter,
  createMcpToolSource,
  createApprovals,
  createToolExecutor,
  inspectRouter,
  toToolset,
  type AfterInfo,
  type McpClientLike,
  type PlainTool,
  type RouterRecord,
} from "../src/index.ts";

// An external MCP server's tools as dendra procedures (#58): approvals,
// after-hooks and inspectRouter cover them like local tools.

function fakeServer(tools: Array<{ name: string; description?: string }> = []) {
  const calls: Array<{ name: string; args: unknown }> = [];
  const client: McpClientLike = {
    async listTools() {
      return {
        tools: [
          {
            name: "issues.create",
            description: "Create an issue",
            inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
          },
          { name: "search", description: "Search code", inputSchema: { type: "object", properties: {} } },
          { name: "fail", inputSchema: { type: "object", properties: {} } },
          ...tools,
        ],
      };
    },
    async callTool({ name, arguments: args }) {
      calls.push({ name, args });
      if (name === "fail") return { content: [{ type: "text", text: "remote said no" }], isError: true };
      return { content: [{ type: "text", text: JSON.stringify({ ok: name }) }] };
    },
  };
  return { client, calls };
}

const { route } = initDendra<{ user: string }>();
const local = { notes: { list: route.ai().handler(() => []) } } satisfies RouterRecord;
const ctx = { user: "ann" };

describe("createMcpRouter", () => {
  it("mounts remote tools as procedures, dotted names nested", async () => {
    const gh = await createMcpRouter(fakeServer().client);
    const router = { ...local, gh };
    const names = (toToolset(router, { format: "plain" }) as PlainTool[]).map((t) => t.name).sort();
    expect(names).toEqual(["gh.fail", "gh.issues.create", "gh.search", "notes.list"]);
    const create = (toToolset(router, { format: "plain" }) as PlainTool[]).find((t) => t.name === "gh.issues.create")!;
    expect(create.description).toBe("Create an issue");
    expect(create.inputSchema).toMatchObject({ required: ["title"] });
  });

  it("calls the remote tool by its own name and parses JSON results", async () => {
    const { client, calls } = fakeServer();
    const router = { gh: await createMcpRouter(client) };
    expect(await createToolExecutor(router, ctx)("gh.issues.create", { title: "Bug" })).toEqual({
      ok: "issues.create",
    });
    expect(calls).toEqual([{ name: "issues.create", args: { title: "Bug" } }]);
  });

  it("a remote error is BAD_GATEWAY with the server's text", async () => {
    const router = { gh: await createMcpRouter(fakeServer().client) };
    await expect(createToolExecutor(router, ctx)("gh.fail", {})).rejects.toMatchObject({
      code: "BAD_GATEWAY",
      message: "remote said no",
    });
  });

  it("requires approval for the tools confirm picks, via createApprovals", async () => {
    const { client, calls } = fakeServer();
    const router = { gh: await createMcpRouter(client, { confirm: (name) => name !== "search" }) };
    const approvals = createApprovals(router);
    const execute = createToolExecutor(router, ctx, { approvals });

    expect(await execute("gh.search", {})).toEqual({ ok: "search" });
    const pending = (await execute("gh.issues.create", { title: "Bug" })) as { status: string; actionId: string };
    expect(pending.status).toBe("pending_approval");
    expect(calls.map((c) => c.name)).toEqual(["search"]);

    expect(await approvals.approve(pending.actionId, ctx)).toEqual({ ok: "issues.create" });
    expect(calls.map((c) => c.name)).toEqual(["search", "issues.create"]);
  });

  it("confirm: true covers every tool", async () => {
    const router = { gh: await createMcpRouter(fakeServer().client, { confirm: true }) };
    expect(inspectRouter(router).every((r) => r.confirm)).toBe(true);
  });

  it("shows in inspectRouter with meta naming the server's tool", async () => {
    const router = { gh: await createMcpRouter(fakeServer().client) };
    const info = inspectRouter(router).find((r) => r.path === "gh.issues.create")!;
    expect(info).toMatchObject({ ai: true, confirm: false, meta: { mcp: { tool: "issues.create" } } });
  });

  it("runs .use() guards and after-hooks the app passes in", async () => {
    const seen: AfterInfo<unknown, unknown>[] = [];
    const guarded = route
      .after((i) => void seen.push(i as AfterInfo<unknown, unknown>))
      .use(function signedIn({ ctx }) {
        if (!ctx.user) throw new Error("no user");
      });
    const router = { gh: await createMcpRouter(fakeServer().client, { route: guarded }) };
    await createToolExecutor(router, ctx)("gh.search", {});
    expect(seen.map((i) => [i.path, i.transport, i.ok])).toEqual([["gh.search", "tool", true]]);
    expect(inspectRouter(router)[0].middlewares).toEqual(["signedIn"]);
  });

  it("keeps only the tools filter allows", async () => {
    const router = { gh: await createMcpRouter(fakeServer().client, { filter: (n) => n === "search" }) };
    expect(inspectRouter(router).map((r) => r.path)).toEqual(["gh.search"]);
  });

  it("caps remote descriptions", async () => {
    const long = "x".repeat(5000);
    const gh = await createMcpRouter(fakeServer([{ name: "long", description: long }]).client, {
      maxDescriptionLength: 100,
    });
    const tool = (toToolset({ gh }, { format: "plain" }) as PlainTool[]).find((t) => t.name === "gh.long")!;
    expect(tool.description.length).toBeLessThanOrEqual(100);
  });

  it("rejects a tool name that is also another tool's namespace", async () => {
    await expect(
      createMcpRouter(fakeServer([{ name: "issues" }]).client),
    ).rejects.toThrow(/issues/);
  });

  it("rejects input that isn't an object before calling the server", async () => {
    const { client, calls } = fakeServer();
    const router = { gh: await createMcpRouter(client) };
    await expect(createToolExecutor(router, ctx)("gh.search", "nope")).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(calls).toEqual([]);
  });
});

describe("createMcpToolSource description cap", () => {
  it("caps remote descriptions at 1,024 characters by default", async () => {
    const source = await createMcpToolSource(fakeServer([{ name: "long", description: "y".repeat(5000) }]).client, {
      format: "plain",
    });
    const tool = (source.tools as PlainTool[]).find((t) => t.name === "long")!;
    expect(tool.description.length).toBeLessThanOrEqual(1024);
  });
});

