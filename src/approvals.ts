// Human confirmation for tool calls. A `.ai({ confirm: true })` procedure never
// runs on the model's say-so: the tool call validates, passes the `.use()`
// guards, and is stored as a pending action. A person then approves it (the
// handler runs) or rejects it. Both steps go through the normal invoke path, so
// after-hooks see the proposal and the decision — the audit trail — with
// `approval` set.

import type { AnyProc, Approval, RouterRecord } from "./core.ts";
import { invokeWith, resolveProc } from "./core.ts";
import { DendraError } from "./errors.ts";

/** A tool call waiting for a person's decision. */
export interface PendingAction {
  id: string;
  /** Dotted procedure path, e.g. "posts.publish". */
  tool: string;
  /** The model's arguments, as sent (JSON); validated again on approval. */
  input: unknown;
  /** From `scope(ctx)` at proposal time; decisions must match it. */
  scope?: string;
  createdAt: number;
}

/** What the model gets back from a confirm tool instead of the result. */
export interface PendingResult {
  status: "pending_approval";
  actionId: string;
  message: string;
}

/** True for a confirm tool's result: the call is waiting for approval. */
export function isPendingResult(v: unknown): v is PendingResult {
  return (
    typeof v === "object" && v !== null &&
    (v as PendingResult).status === "pending_approval" &&
    typeof (v as PendingResult).actionId === "string"
  );
}

/** Where pending actions live. Bring your own for multi-instance apps. */
export interface ApprovalStore {
  add(action: PendingAction): Promise<void>;
  get(id: string): Promise<PendingAction | null>;
  /** Remove and return it — atomically, so an action is decided once. */
  take(id: string): Promise<PendingAction | null>;
  list(scope?: string): Promise<PendingAction[]>;
}

/** A single-process store, for development and tests. Lost on restart. */
export function createInMemoryApprovalStore(): ApprovalStore {
  const actions = new Map<string, PendingAction>();
  return {
    async add(action) {
      actions.set(action.id, structuredClone(action));
    },
    async get(id) {
      const a = actions.get(id);
      return a ? structuredClone(a) : null;
    },
    async take(id) {
      const a = actions.get(id);
      if (!a) return null;
      actions.delete(id);
      return a;
    },
    async list(scope) {
      return [...actions.values()]
        .filter((a) => scope === undefined || a.scope === scope)
        .map((a) => structuredClone(a));
    },
  };
}

export interface ApprovalsOptions<Ctx> {
  store?: ApprovalStore;
  /**
   * Who may see and decide an action, from ctx (e.g. the tenant id). Recorded
   * when the model proposes; `list`, `get`, `approve` and `reject` only find
   * actions whose scope matches the caller's. Set it in multi-tenant apps.
   */
  scope?: (ctx: Ctx) => string | undefined;
}

export interface Approvals<Ctx> {
  /** Pending actions in the caller's scope. */
  list(ctx: Ctx): Promise<PendingAction[]>;
  get(id: string, ctx: Ctx): Promise<PendingAction | null>;
  /**
   * Run the proposed call. Guards re-run with the approver's ctx; if they
   * reject, the action stays pending. Returns the handler's result.
   */
  approve(id: string, ctx: Ctx): Promise<unknown>;
  /** Drop the action. After-hooks record it as a FORBIDDEN failure. */
  reject(id: string, ctx: Ctx, reason?: string): Promise<void>;
  /** @internal Used by the tool executor; apps don't call it. */
  propose(proc: AnyProc, name: string, args: unknown, ctx: Ctx): Promise<PendingResult>;
}

/** Pending-action storage and decisions for a router's confirm tools. */
export function createApprovals<Ctx>(
  router: object,
  opts: ApprovalsOptions<Ctx> = {},
): Approvals<Ctx> {
  const store = opts.store ?? createInMemoryApprovalStore();
  const scopeOf = (ctx: Ctx) => opts.scope?.(ctx);

  const find = async (id: string, ctx: Ctx) => {
    const action = await store.get(id);
    return action && action.scope === scopeOf(ctx) ? action : null;
  };
  // The action and its procedure, or NOT_FOUND — for a missing id and for one
  // in another scope alike, so ids from other tenants can't be probed.
  const load = async (id: string, ctx: Ctx) => {
    const action = await find(id, ctx);
    const proc = action && resolveProc(router as RouterRecord, action.tool.split("."));
    if (!action || !proc) throw new DendraError("NOT_FOUND", `No pending action '${id}'`);
    return { action, proc };
  };
  const take = async (id: string) => {
    if (!(await store.take(id))) {
      throw new DendraError("CONFLICT", `Action '${id}' was already decided`);
    }
  };

  return {
    list: (ctx) => store.list(scopeOf(ctx)),
    get: find,

    async approve(id, ctx) {
      const { action, proc } = await load(id, ctx);
      const approval: Approval = { id, status: "approved" };
      const site = { path: action.tool, transport: "tool" as const, approval };
      return invokeWith(proc, action.input, ctx, site, async (input, ctx2) => {
        await take(id);
        const out = proc.handler(input, ctx2);
        return proc.kind === "stream" ? collect(out as AsyncIterable<unknown>) : out;
      });
    },

    async reject(id, ctx, reason) {
      const { action, proc } = await load(id, ctx);
      const approval: Approval = { id, status: "rejected", ...(reason ? { reason } : {}) };
      const site = { path: action.tool, transport: "tool" as const, approval };
      // After-hooks record the rejection as a failure; for us it's the outcome.
      const rejection = new DendraError("FORBIDDEN", reason ? `Rejected: ${reason}` : "Rejected");
      await invokeWith(proc, action.input, ctx, site, async () => {
        await take(id);
        throw rejection;
      }).catch((e) => {
        if (e !== rejection) throw e;
      });
    },

    async propose(proc, name, args, ctx) {
      const actionId = crypto.randomUUID();
      const site = {
        path: name,
        transport: "tool" as const,
        approval: { id: actionId, status: "pending" as const },
      };
      return invokeWith(proc, args, ctx, site, async () => {
        const scope = scopeOf(ctx);
        await store.add({
          id: actionId,
          tool: name,
          input: args,
          ...(scope !== undefined ? { scope } : {}),
          createdAt: Date.now(),
        });
        return {
          status: "pending_approval",
          actionId,
          message: "Waiting for a person to approve this action. It has not run yet.",
        } satisfies PendingResult;
      }) as Promise<PendingResult>;
    },
  };
}

/** Collect a streaming tool's chunks: joined if all strings, else the array. */
export async function collect(stream: AsyncIterable<unknown>): Promise<unknown> {
  const chunks: unknown[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks.every((c) => typeof c === "string") ? chunks.join("") : chunks;
}
