import { describe, it, expect } from "vitest";
import {
  initDendra,
  createApprovals,
  createToolExecutor,
  createMcpBridge,
  toToolset,
  mcpToolDefinitions,
  inspectRouter,
  DendraError,
  s,
  type AfterInfo,
  type PlainTool,
  type StandardSchemaV1,
} from "../src/index.ts";
import { runAgent } from "../src/anthropic.ts";
import type { AgentPart } from "../src/agent.ts";

interface Ctx {
  tenant: string;
  role: "editor" | "viewer";
}
const { route } = initDendra<Ctx>();

const audit: Array<Pick<AfterInfo<Ctx, unknown>, "path" | "ok" | "approval"> & { by: string }> = [];
const published: string[] = [];

const editorOnly = ({ ctx }: { ctx: Ctx }) => {
  if (ctx.role !== "editor") throw new DendraError("FORBIDDEN", "Editors only");
};

const router = {
  publish: route
    .after(({ ctx, path, ok, approval }) => {
      audit.push({ path, ok, approval, by: ctx.role });
    })
    .use(editorOnly)
    .input(s.object({ postId: s.string() }))
    .ai({ description: "Publish a post", confirm: true })
    .handler(({ input, ctx }) => {
      published.push(`${ctx.tenant}:${input.postId}`);
      return { live: input.postId };
    }),
  approve: route.noAi().handler(() => "ok"),
  draft: route.get("/drafts").ai().handler(() => []),
  tail: route.ai({ confirm: true }).stream(async function* () {
    yield "a";
    yield "b";
  }),
};

const alice: Ctx = { tenant: "t1", role: "editor" };

function reset() {
  audit.length = 0;
  published.length = 0;
}

describe(".noAi()", () => {
  it("throws when combined with .ai(), in either order", () => {
    expect(() => route.noAi().ai()).toThrow(/noAi/);
    expect(() => route.ai().noAi()).toThrow(/noAi/);
  });

  it("is reported by inspectRouter, and isn't a tool", () => {
    const byPath = Object.fromEntries(inspectRouter(router).map((p) => [p.path, p]));
    expect(byPath.approve).toMatchObject({ ai: false, noAi: true, confirm: false });
    expect(byPath.publish).toMatchObject({ ai: true, noAi: false, confirm: true });
    const names = (toToolset(router, { format: "plain" }) as PlainTool[]).map((t) => t.name);
    expect(names).not.toContain("approve");
  });
});

describe(".ai({ confirm: true })", () => {
  it("tells the model the tool needs approval, and annotates it for MCP", () => {
    const [tool] = (toToolset({ publish: router.publish }, { format: "plain" }) as PlainTool[]);
    expect(tool.description).toMatch(/^Publish a post \(Needs a person's approval/);
    const defs = Object.fromEntries(mcpToolDefinitions(router).map((d) => [d.name, d]));
    expect(defs.publish.annotations).toEqual({ readOnlyHint: false, destructiveHint: true });
    expect(defs.draft.annotations).toEqual({ readOnlyHint: true });
  });

  it("fails closed without approvals: the handler never runs", async () => {
    reset();
    const execute = createToolExecutor(router, alice);
    await expect(execute("publish", { postId: "p1" })).rejects.toThrow(/needs approval/);
    expect(published).toEqual([]);
  });

  it("proposes, then runs on approval with the approver's ctx; hooks see both", async () => {
    reset();
    const approvals = createApprovals<Ctx>(router);
    const execute = createToolExecutor(router, alice, { approvals });

    const pending = (await execute("publish", { postId: "p1" })) as { actionId: string };
    expect(pending).toMatchObject({ status: "pending_approval" });
    expect(published).toEqual([]);
    expect(await approvals.list(alice)).toMatchObject([
      { id: pending.actionId, tool: "publish", input: { postId: "p1" } },
    ]);

    expect(await approvals.approve(pending.actionId, alice)).toEqual({ live: "p1" });
    expect(published).toEqual(["t1:p1"]);
    expect(audit).toEqual([
      { path: "publish", ok: true, by: "editor", approval: { id: pending.actionId, status: "pending" } },
      { path: "publish", ok: true, by: "editor", approval: { id: pending.actionId, status: "approved" } },
    ]);
    expect(await approvals.list(alice)).toEqual([]);
    await expect(approvals.approve(pending.actionId, alice)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("runs the guards at proposal time too", async () => {
    reset();
    const approvals = createApprovals<Ctx>(router);
    const execute = createToolExecutor(router, { tenant: "t1", role: "viewer" }, { approvals });
    await expect(execute("publish", { postId: "p1" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await approvals.list(alice)).toEqual([]);
  });

  it("keeps the action pending when the approver fails the guards", async () => {
    reset();
    const approvals = createApprovals<Ctx>(router);
    const { actionId } = (await createToolExecutor(router, alice, { approvals })("publish", {
      postId: "p1",
    })) as { actionId: string };
    const viewer: Ctx = { tenant: "t1", role: "viewer" };
    await expect(approvals.approve(actionId, viewer)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(published).toEqual([]);
    expect(await approvals.get(actionId, alice)).not.toBeNull();
  });

  it("records a rejection as a FORBIDDEN failure with the reason", async () => {
    reset();
    const approvals = createApprovals<Ctx>(router);
    const { actionId } = (await createToolExecutor(router, alice, { approvals })("publish", {
      postId: "p1",
    })) as { actionId: string };
    await approvals.reject(actionId, alice, "typo in title");
    expect(published).toEqual([]);
    expect(audit[1]).toEqual({
      path: "publish",
      ok: false,
      by: "editor",
      approval: { id: actionId, status: "rejected", reason: "typo in title" },
    });
    expect(await approvals.list(alice)).toEqual([]);
  });

  it("decides an action only once under concurrent approvals", async () => {
    reset();
    const approvals = createApprovals<Ctx>(router);
    const { actionId } = (await createToolExecutor(router, alice, { approvals })("publish", {
      postId: "p1",
    })) as { actionId: string };
    const results = await Promise.allSettled([
      approvals.approve(actionId, alice),
      approvals.approve(actionId, alice),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(published).toEqual(["t1:p1"]);
  });

  it("scopes actions: another tenant can't see or decide them", async () => {
    reset();
    const approvals = createApprovals<Ctx>(router, { scope: (ctx) => ctx.tenant });
    const { actionId } = (await createToolExecutor(router, alice, { approvals })("publish", {
      postId: "p1",
    })) as { actionId: string };
    const mallory: Ctx = { tenant: "t2", role: "editor" };
    expect(await approvals.list(mallory)).toEqual([]);
    expect(await approvals.get(actionId, mallory)).toBeNull();
    await expect(approvals.approve(actionId, mallory)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(approvals.reject(actionId, mallory)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await approvals.list(alice)).toHaveLength(1);
  });

  it("records proposedBy from the proposer option", async () => {
    reset();
    const approvals = createApprovals<Ctx>(router, { proposer: (ctx) => `${ctx.tenant}/${ctx.role}` });
    const { actionId } = (await createToolExecutor(router, alice, { approvals })("publish", {
      postId: "p2",
    })) as { actionId: string };
    expect(await approvals.get(actionId, alice)).toMatchObject({ proposedBy: "t1/editor" });
  });

  it("keeps propose off the public Approvals object", () => {
    const approvals = createApprovals<Ctx>(router);
    expect("propose" in approvals).toBe(false);
  });

  it("rejects approvals not made by createApprovals", async () => {
    const fake = { list: async () => [], get: async () => null, approve: async () => null, reject: async () => {} };
    await expect(
      createToolExecutor(router, alice, { approvals: fake })("publish", { postId: "p" }),
    ).rejects.toThrow(/createApprovals/);
    expect(published).not.toContain("t1:p");
  });

  it("collects a streaming confirm tool on approval", async () => {
    const approvals = createApprovals<Ctx>(router);
    const { actionId } = (await createToolExecutor(router, alice, { approvals })("tail", {})) as {
      actionId: string;
    };
    expect(await approvals.approve(actionId, alice)).toBe("ab");
  });

  it("works through the MCP bridge", async () => {
    reset();
    const approvals = createApprovals<Ctx>(router);
    const bridge = createMcpBridge(router, alice, { approvals });
    const res = await bridge.callTool("publish", { postId: "p9" });
    expect(JSON.parse(res.content[0].text)).toMatchObject({ status: "pending_approval" });
    expect(published).toEqual([]);
  });

  it("runAgent marks the tool part with its approvalId", async () => {
    reset();
    const approvals = createApprovals<Ctx>(router);
    let turn = 0;
    const client = {
      messages: {
        stream() {
          const content =
            turn++ === 0
              ? [{ type: "tool_use", id: "x", name: "publish", input: { postId: "p1" } }]
              : [{ type: "text", text: "Sent for approval." }];
          return {
            async *[Symbol.asyncIterator]() {},
            async finalMessage() {
              return { content, stop_reason: turn === 1 ? "tool_use" : "end_turn" };
            },
          };
        },
      },
    };
    const parts: AgentPart[] = [];
    for await (const p of runAgent({
      client: client as never,
      model: "test",
      tools: toToolset(router) as never,
      execute: createToolExecutor(router, alice, { approvals }),
      prompt: "publish p1",
    })) {
      parts.push(p);
    }
    const tool = parts.find((p) => p.type === "tool");
    const [pending] = await approvals.list(alice);
    expect(tool).toMatchObject({ name: "publish", approvalId: pending.id });
    expect(published).toEqual([]);
  });
});

describe("approvals with transforming schemas", () => {
  it("stores the raw arguments, so approval validates them like a fresh call", async () => {
    const asDate: StandardSchemaV1<unknown, { at: Date }> = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: (v: unknown) =>
          typeof (v as { at?: unknown })?.at === "string"
            ? { value: { at: new Date((v as { at: string }).at) } }
            : { issues: [{ message: "at must be a string" }] },
      },
    };
    const r = {
      schedule: route
        .input(asDate)
        .ai({ confirm: true })
        .handler(({ input }) => input.at.toISOString()),
    };
    const approvals = createApprovals<Ctx>(r);
    const { actionId } = (await createToolExecutor(r, alice, { approvals })("schedule", {
      at: "2026-01-01T00:00:00.000Z",
    })) as { actionId: string };
    expect((await approvals.get(actionId, alice))?.input).toEqual({ at: "2026-01-01T00:00:00.000Z" });
    expect(await approvals.approve(actionId, alice)).toBe("2026-01-01T00:00:00.000Z");
  });
});
