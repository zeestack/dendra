// The core: a procedure is `{ metadata + schema + handler }` as plain data.
// No decorators, no classes-as-routes, no reflect-metadata. One definition is
// consumed twice — as a TYPE (flows to the client, zero runtime) and as a VALUE
// (dispatched by the server adapter). Validation lives in one place here so
// every transport (HTTP, in-process caller, AI tool executor) shares it.

import type {
  InferOutput,
  JSONSchema,
  StandardSchemaV1,
} from "./schema.ts";
import { NexusError } from "./errors.ts";

export type ProcedureKind = "unary" | "stream";
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

// A middleware runs before the handler. It can reject (throw a NexusError) or
// return an object that is MERGED into ctx for everything downstream — so the
// handler sees an enriched, typed context. Returning nothing leaves ctx as-is.
export type Middleware<Ctx, In, CtxAdd> = (opts: {
  ctx: Ctx;
  input: In;
}) => CtxAdd | void | Promise<CtxAdd | void>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMiddleware = (opts: { ctx: any; input: any }) => any;

export interface Proc<
  Ctx = unknown,
  In = unknown,
  Out = unknown,
  K extends ProcedureKind = "unary",
> {
  readonly _nexus: true;
  readonly kind: K;
  readonly method: HttpMethod;
  readonly path?: string;
  readonly description?: string;
  readonly ai?: { expose: boolean; description?: string };
  readonly inputSchema?: StandardSchemaV1<unknown, In>;
  readonly inputJsonSchema?: JSONSchema;
  readonly outputJsonSchema?: JSONSchema;
  readonly middlewares?: ReadonlyArray<AnyMiddleware>;
  readonly handler: (input: In, ctx: Ctx) => Promise<Out> | AsyncIterable<Out>;
  // Phantom carrier so inference can recover In/Out even when erased elsewhere.
  readonly _types?: { in: In; out: Out };
}

// Structural "bag" type used only for storage/dispatch. `any` (not `unknown`)
// is deliberate: handler parameters are contravariant, so a concrete
// Proc<Ctx, {a,b}, ...> is only assignable here when these slots are `any`.
// Inference never flows through AnyProc — `Client<R>` reads the concrete
// `typeof router` — so this erasure costs no end-user type safety.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyProc = Proc<any, any, any, ProcedureKind>;
export interface RouterRecord {
  [k: string]: AnyProc | RouterRecord;
}

interface State<Ctx, In> {
  method: HttpMethod;
  path?: string;
  description?: string;
  ai?: { expose: boolean; description?: string };
  inputSchema?: StandardSchemaV1<unknown, In>;
  inputJsonSchema?: JSONSchema;
  outputJsonSchema?: JSONSchema;
  middlewares?: AnyMiddleware[];
}

class Builder<Ctx, In> {
  readonly state: State<Ctx, In>;
  constructor(state: State<Ctx, In>) {
    this.state = state;
  }
  private next<In2>(patch: Partial<State<Ctx, In2>>): Builder<Ctx, In2> {
    return new Builder<Ctx, In2>({
      ...(this.state as unknown as State<Ctx, In2>),
      ...patch,
    });
  }
  get(path: string) {
    return this.next<In>({ method: "GET", path });
  }
  post(path: string) {
    return this.next<In>({ method: "POST", path });
  }
  put(path: string) {
    return this.next<In>({ method: "PUT", path });
  }
  patch(path: string) {
    return this.next<In>({ method: "PATCH", path });
  }
  delete(path: string) {
    return this.next<In>({ method: "DELETE", path });
  }
  describe(description: string) {
    return this.next<In>({ description });
  }
  /** Expose this procedure to LLMs as a callable tool (opt-in, never default). */
  ai(cfg: { description?: string } = {}) {
    return this.next<In>({ ai: { expose: true, description: cfg.description } });
  }
  /**
   * Add a middleware. It runs before the handler (across RPC, REST, the caller,
   * WebSocket, and AI/MCP tool execution). Throw a NexusError to reject; return
   * an object to merge it into ctx — the downstream handler sees the enriched,
   * typed context.
   */
  use<CtxAdd extends Record<string, unknown> | void>(
    mw: Middleware<Ctx, In, CtxAdd>,
  ): Builder<Ctx & (CtxAdd extends void ? unknown : CtxAdd), In> {
    return new Builder<Ctx & (CtxAdd extends void ? unknown : CtxAdd), In>({
      ...(this.state as unknown as State<
        Ctx & (CtxAdd extends void ? unknown : CtxAdd),
        In
      >),
      middlewares: [...(this.state.middlewares ?? []), mw as AnyMiddleware],
    });
  }
  /** Attach an input schema. Any Standard Schema works (Zod/Valibot/built-in). */
  input<S extends StandardSchemaV1>(schema: S) {
    const jsonSchema = (schema as { jsonSchema?: JSONSchema }).jsonSchema;
    return this.next<InferOutput<S>>({
      inputSchema: schema as StandardSchemaV1<unknown, InferOutput<S>>,
      inputJsonSchema: jsonSchema,
    });
  }
  /** Document the response shape (used by OpenAPI). Does not change types. */
  output(schema: { jsonSchema?: JSONSchema }) {
    return this.next<In>({ outputJsonSchema: schema.jsonSchema });
  }
  /** Unary procedure: returns a value. */
  handler<Out>(
    fn: (o: { input: In; ctx: Ctx }) => Out | Promise<Out>,
  ): Proc<Ctx, In, Awaited<Out>, "unary"> {
    const s = this.state;
    return {
      _nexus: true,
      kind: "unary",
      method: s.method,
      path: s.path,
      description: s.description,
      ai: s.ai,
      inputSchema: s.inputSchema,
      inputJsonSchema: s.inputJsonSchema,
      outputJsonSchema: s.outputJsonSchema,
      middlewares: s.middlewares,
      handler: async (input: In, ctx: Ctx) => fn({ input, ctx }),
    } as Proc<Ctx, In, Awaited<Out>, "unary">;
  }
  /** Streaming procedure: returns an async iterable of elements. */
  stream<Out>(
    fn: (o: { input: In; ctx: Ctx }) => AsyncIterable<Out>,
  ): Proc<Ctx, In, Out, "stream"> {
    const s = this.state;
    return {
      _nexus: true,
      kind: "stream",
      method: s.method,
      path: s.path,
      description: s.description,
      ai: s.ai,
      inputSchema: s.inputSchema,
      inputJsonSchema: s.inputJsonSchema,
      outputJsonSchema: s.outputJsonSchema,
      middlewares: s.middlewares,
      handler: (input: In, ctx: Ctx) => fn({ input, ctx }),
    } as Proc<Ctx, In, Out, "stream">;
  }
}

/** Bind a context type, then define procedures off `route`. */
export function initNexus<Ctx = Record<string, never>>() {
  const route = new Builder<Ctx, void>({ method: "POST" });
  return { route };
}

export function resolveProc(
  router: RouterRecord,
  segments: string[],
): AnyProc | undefined {
  let cur: AnyProc | RouterRecord | undefined = router;
  for (const seg of segments) {
    if (!cur || (cur as AnyProc)._nexus) return undefined;
    cur = (cur as RouterRecord)[seg];
  }
  return cur && (cur as AnyProc)._nexus ? (cur as AnyProc) : undefined;
}

async function validateInput(proc: AnyProc, raw: unknown): Promise<unknown> {
  if (!proc.inputSchema) return raw;
  const res = await proc.inputSchema["~standard"].validate(raw);
  if ((res as { issues?: unknown }).issues !== undefined) {
    throw new NexusError(
      "BAD_REQUEST",
      "Input validation failed",
      400,
      (res as { issues: unknown }).issues,
    );
  }
  return (res as { value: unknown }).value;
}

// Run the middleware chain: each one may reject (throw) or return a ctx patch
// that is merged in for everything downstream.
async function runMiddleware(
  proc: AnyProc,
  input: unknown,
  ctx: unknown,
): Promise<unknown> {
  const mws = proc.middlewares;
  if (!mws || mws.length === 0) return ctx;
  let acc = ctx;
  for (const mw of mws) {
    const patch = await mw({ ctx: acc, input });
    if (patch && typeof patch === "object") {
      acc = { ...(acc as object), ...(patch as object) };
    }
  }
  return acc;
}

/** Run a unary procedure: validate, run middleware, then call the handler. */
export async function invokeUnary(
  proc: AnyProc,
  raw: unknown,
  ctx: unknown,
): Promise<unknown> {
  const input = await validateInput(proc, raw);
  const ctx2 = await runMiddleware(proc, input, ctx);
  return (await proc.handler(input, ctx2)) as unknown;
}

/** Run a streaming procedure: validate, run middleware, then yield. */
export async function* invokeStream(
  proc: AnyProc,
  raw: unknown,
  ctx: unknown,
): AsyncIterable<unknown> {
  const input = await validateInput(proc, raw);
  const ctx2 = await runMiddleware(proc, input, ctx);
  yield* proc.handler(input, ctx2) as AsyncIterable<unknown>;
}
