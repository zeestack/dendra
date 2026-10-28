// The core: a procedure is `{ metadata + schema + handler }` as plain data.
// No decorators, no classes-as-routes, no reflect-metadata. One definition is
// consumed twice — as a TYPE (flows to the client, zero runtime) and as a VALUE
// (dispatched by the server adapter). Validation lives in one place here so
// every transport (HTTP, in-process caller, AI tool executor) shares it.

import type {
  InferOutput,
  JSONSchema,
  StandardIssue,
  StandardSchemaV1,
} from "./schema.ts";
import { DendraError, type ErrorCode } from "./errors.ts";
import { objectShapeOf } from "./object-shape.ts";
import { fileFields, fileMeta, isFileResult } from "./files.ts";

export type ProcedureKind = "unary" | "stream";
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

// A middleware runs before the handler. It can reject (throw a DendraError) or
// return an object that is MERGED into ctx for everything downstream — so the
// handler sees an enriched, typed context. Returning nothing leaves ctx as-is.
export type Middleware<Ctx, In, CtxAdd> = (opts: {
  ctx: Ctx;
  input: In;
}) => CtxAdd | void | Promise<CtxAdd | void>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMiddleware = (opts: { ctx: any; input: any }) => any;

/** Which transport a call arrived on — handy for "was this the model?" audits. */
export type Transport = "rpc" | "rest" | "caller" | "ws" | "tool";

/** Where a call came from, threaded through `invokeUnary` / `invokeStream`. */
export interface CallSite {
  path?: string;
  transport?: Transport;
  /** Part of a request batch (which, like WS and tools, can't carry files). */
  batch?: boolean;
  /** Fires when the caller goes away (client disconnect, abort, unsubscribe). */
  signal?: AbortSignal;
  /** Set on `.ai({ confirm: true })` calls: the proposal and the decision. */
  approval?: Approval;
}

/**
 * Where a confirm-tool call stands. `pending` = the model proposed it (the
 * handler didn't run); `approved` / `rejected` = a person decided.
 */
export interface Approval {
  id: string;
  status: "pending" | "approved" | "rejected";
  reason?: string;
}

// File results are raw HTTP responses; transports that speak JSON frames can't
// carry them. Failing inside invoke (not in each transport) means after-hooks
// record the failure too.
function rejectFileResult(result: unknown, site: CallSite): void {
  if (!isFileResult(result)) return;
  const path = site.path ?? "";
  if (site.transport === "tool") {
    throw new DendraError(
      "NOT_IMPLEMENTED",
      `Tool '${path}' returned a file; file outputs can't be tool results`,
    );
  }
  const over = site.batch ? "batch" : site.transport === "ws" ? "WebSocket" : undefined;
  if (over) {
    throw new DendraError(
      "NOT_IMPLEMENTED",
      `'${path}' returned a file; file outputs aren't supported over ${over}`,
    );
  }
}

// What an after-hook sees once the call settles. `ok` discriminates success
// (with `result`; undefined for streams) from failure (with the thrown `error`
// and its `code` — "INTERNAL" for anything that isn't a DendraError).
export type AfterInfo<Ctx, In> = {
  ctx: Ctx;
  input: In;
  path: string;
  transport: Transport;
  durationMs: number;
  /** Only on `.ai({ confirm: true })` tool calls and their decisions. */
  approval?: Approval;
} & (
  | { ok: true; result: unknown; error?: undefined; code?: undefined }
  | { ok: false; result?: undefined; error: unknown; code: ErrorCode }
);

export type AfterHook<Ctx, In> = (info: AfterInfo<Ctx, In>) => void | Promise<void>;

// `at` = how many middlewares preceded the hook in the chain. The hook runs only
// if those all passed, and sees ctx as it was at that point — so its typed ctx
// is never a lie, and a hook placed before an auth guard also sees rejections.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AfterEntry = { at: number; fn: AfterHook<any, any> };

export interface Proc<
  Ctx = unknown,
  In = unknown,
  Out = unknown,
  K extends ProcedureKind = "unary",
> {
  readonly _dendra: true;
  readonly kind: K;
  readonly method: HttpMethod;
  readonly path?: string;
  readonly description?: string;
  readonly ai?: AiConfig;
  readonly noAi?: boolean;
  readonly inputSchema?: StandardSchemaV1<unknown, In>;
  readonly inputJsonSchema?: JSONSchema;
  readonly outputJsonSchema?: JSONSchema;
  readonly middlewares?: ReadonlyArray<AnyMiddleware>;
  /** One per middleware, in order: its `{ name }`, else the function's name. */
  readonly middlewareNames?: ReadonlyArray<string>;
  readonly meta?: Readonly<Record<string, unknown>>;
  readonly afterHooks?: ReadonlyArray<AfterEntry>;
  readonly handler: (
    input: In,
    ctx: Ctx,
    signal?: AbortSignal,
  ) => Promise<Out> | AsyncIterable<Out>;
  // Phantom carrier so inference can recover In/Out even when erased elsewhere.
  readonly _types?: { in: In; out: Out };
}

/**
 * Type-level marker for procedures declared with `.get()`: reads that are safe
 * to reach by GET (and so by a link or `<img src>`). `urlFor` requires it.
 */
export type ReadBrand = { readonly _read: true };
type Branded<P, Rd extends boolean> = Rd extends true ? P & ReadBrand : P;

// Structural "bag" type used only for storage/dispatch. `any` (not `unknown`)
// is deliberate: handler parameters are contravariant, so a concrete
// Proc<Ctx, {a,b}, ...> is only assignable here when these slots are `any`.
// Inference never flows through AnyProc — `Client<R>` reads the concrete
// `typeof router` — so this erasure costs no end-user type safety.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyProc = Proc<any, any, any, ProcedureKind>;
/**
 * MCP tool annotations (the spec's `ToolAnnotations`): hints that tell an MCP
 * client what a tool does, so it can decide what to ask the user about.
 */
export interface ToolAnnotations {
  /** A human-readable name for the tool. */
  title?: string;
  /** The tool doesn't change anything. */
  readOnlyHint?: boolean;
  /** A change it makes may destroy or overwrite data (meaningful when not read-only). */
  destructiveHint?: boolean;
  /** Calling it again with the same arguments has no further effect. */
  idempotentHint?: boolean;
  /** It reaches outside the app (the web, another company's API). */
  openWorldHint?: boolean;
}

export interface AiConfig {
  expose: boolean;
  description?: string;
  /** Tool calls propose a pending action; a person approves before it runs. */
  confirm?: boolean;
  /** Streaming tools: stop collecting after this many chunks. Default 1,000. */
  maxItems?: number;
  /** Streaming tools: stop collecting after this long, in ms. Default 30 s. */
  timeoutMs?: number;
  /** MCP annotations, over the ones derived from `.get()` and `confirm`. */
  annotations?: ToolAnnotations;
}

/**
 * A tool's MCP annotations: `.get()` is read-only, a confirm tool is
 * destructive, and `.ai({ annotations })` overrides either. Read-only wins over
 * a derived destructive hint, which only means something for a tool that writes.
 */
export function toolAnnotations(proc: AnyProc): ToolAnnotations {
  const derived: ToolAnnotations =
    proc.method === "GET"
      ? { readOnlyHint: true }
      : proc.ai?.confirm
        ? { readOnlyHint: false, destructiveHint: true }
        : {};
  const out = { ...derived, ...proc.ai?.annotations };
  if (out.readOnlyHint && proc.ai?.annotations?.destructiveHint === undefined) delete out.destructiveHint;
  return out;
}

export interface RouterRecord {
  [k: string]: AnyProc | RouterRecord;
}

interface State<Ctx, In> {
  method: HttpMethod;
  path?: string;
  description?: string;
  ai?: AiConfig;
  noAi?: boolean;
  inputSchema?: StandardSchemaV1<unknown, In>;
  inputJsonSchema?: JSONSchema;
  /** Why (part of) the input has no JSON Schema; `.ai()` refuses it. */
  inputJsonMissing?: string;
  outputJsonSchema?: JSONSchema;
  middlewares?: AnyMiddleware[];
  middlewareNames?: string[];
  meta?: Record<string, unknown>;
  afterHooks?: AfterEntry[];
}

// Models can't send bytes through a tool call, so a file-input tool could only
// ever fail. Refuse it where it's defined rather than ship a broken tool.
// Likewise a tool whose input has no JSON Schema: the model would see no
// parameters and could only guess.
function assertAiCompatible<Ctx, In>(s: State<Ctx, In>, kind: ProcedureKind): void {
  if (!s.ai?.expose) return;
  if (kind !== "stream" && (s.ai.maxItems !== undefined || s.ai.timeoutMs !== undefined)) {
    throw new Error(".ai({ maxItems, timeoutMs }) only applies to .stream() procedures");
  }
  if (s.method === "GET" && s.ai.annotations?.readOnlyHint === false) {
    throw new Error("A .get() procedure is a read: it can't be .ai({ annotations: { readOnlyHint: false } })");
  }
  if (s.inputJsonMissing) {
    throw new Error(
      `An AI tool needs a JSON Schema for its input, so the model knows the parameters. ` +
        `${s.inputJsonMissing}. Use s.*, Zod 4 or ArkType, or wrap a Valibot schema in ` +
        `toStandardJsonSchema (@valibot/to-json-schema).`,
    );
  }
  const files = fileFields(s.inputJsonSchema);
  if (files.length === 0) return;
  throw new Error(
    `A procedure with file input (${files.join(", ")}) can't be an AI tool: ` +
      `models can't send files through tool calls. Remove .ai().`,
  );
}

// The JSON Schema a schema publishes. Built-in `s.*` schemas carry it as
// `jsonSchema`; other libraries through Standard JSON Schema
// (`~standard.jsonSchema`), as Zod 4 and ArkType do. A library can refuse
// (a Zod `Date`, a transform's output): then `missing` says why.
function jsonSchemaOf(
  schema: StandardSchemaV1,
  io: "input" | "output",
): { json?: JSONSchema; missing?: string } {
  const own = (schema as { jsonSchema?: JSONSchema }).jsonSchema;
  if (own) return { json: own };
  const std = schema["~standard"] as StandardSchemaV1["~standard"] & {
    jsonSchema?: Partial<Record<typeof io, (o: { target: string }) => Record<string, unknown>>>;
  };
  const convert = std.jsonSchema?.[io];
  if (typeof convert !== "function") {
    return { missing: `This ${std.vendor} schema doesn't publish one (Standard JSON Schema)` };
  }
  try {
    // OpenAPI 3.1 and the model APIs use draft 2020-12. `$schema` names a
    // document's dialect; it doesn't belong on an embedded schema.
    const { $schema: _, ...json } = convert.call(std.jsonSchema, { target: "draft-2020-12" });
    return { json: json as JSONSchema };
  } catch (e) {
    return { missing: `${std.vendor} can't convert it: ${e instanceof Error ? e.message : String(e)}` };
  }
}

// Chained `.input()`: the first schema can be anything; after that, both sides
// must be objects. The earlier schema wins a shared key, matching the runtime —
// a guard's checked value is never swapped out from under the handler.
type ChainableInput<In> = [In] extends [void]
  ? unknown
  : In extends Record<string, unknown>
    ? Record<string, unknown>
    : never;
type ChainedInput<In, O> = [In] extends [void]
  ? O
  : { [K in keyof (In & Omit<O, keyof In>)]: (In & Omit<O, keyof In>)[K] };

// `b`'s keys added after `a`'s, never replacing one `a` already has.
function withoutOverride<T>(a: Record<string, T>, b: Record<string, T>): Record<string, T> {
  const out = { ...a };
  for (const k of Object.keys(b)) if (!(k in out)) out[k] = b[k];
  return out;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// Merge a new input schema into the existing one. Two built-in `s.object`s
// become one object (so `.strict()` checks the combined keys); anything else
// runs both schemas on the raw input, reports all issues together, and merges
// the outputs. The JSON schema combines whatever the parts publish.
function extendInput(
  prev: StandardSchemaV1,
  prevJson: JSONSchema | undefined,
  next: StandardSchemaV1,
  nextJson: JSONSchema | undefined,
): { inputSchema: StandardSchemaV1; inputJsonSchema?: JSONSchema } {
  const a = objectShapeOf(prev);
  const b = objectShapeOf(next);
  if (a && b) {
    const shape = withoutOverride(a.shape, b.shape);
    const mode = [a.mode, b.mode].includes("strict")
      ? "strict"
      : [a.mode, b.mode].includes("passthrough")
        ? "passthrough"
        : "strip";
    const merged = a.build(shape, mode);
    return { inputSchema: merged, inputJsonSchema: merged.jsonSchema };
  }
  const inputSchema: StandardSchemaV1 = {
    "~standard": {
      version: 1,
      vendor: "dendra",
      async validate(raw) {
        const results = [
          await prev["~standard"].validate(raw),
          await next["~standard"].validate(raw),
        ];
        const issues: StandardIssue[] = [];
        const values: Record<string, unknown>[] = [];
        for (const r of results) {
          if (r.issues !== undefined) issues.push(...r.issues);
          else if (isPlainObject(r.value)) values.push(r.value);
          else issues.push({ message: "Chained input must be an object" });
        }
        if (issues.length) return { issues };
        return { value: withoutOverride(values[0], values[1]) };
      },
    },
  };
  return { inputSchema, inputJsonSchema: mergeJsonSchemas(prevJson, nextJson) };
}

function mergeJsonSchemas(
  a: JSONSchema | undefined,
  b: JSONSchema | undefined,
): JSONSchema | undefined {
  const parts = [a, b].filter((p): p is JSONSchema => p !== undefined);
  if (parts.length === 0) return undefined;
  let properties: Record<string, JSONSchema> = {};
  const required = new Set<string>();
  for (const p of parts) {
    properties = withoutOverride(properties, p.properties ?? {});
    for (const k of p.required ?? []) required.add(k);
  }
  return { type: "object", properties, required: [...required] };
}

class Builder<
  Ctx,
  In,
  DOut = never,
  Rd extends boolean = false,
  M extends object = Record<string, unknown>,
> {
  readonly state: State<Ctx, In>;
  constructor(state: State<Ctx, In>) {
    this.state = state;
  }
  private next<In2>(patch: Partial<State<Ctx, In2>>): Builder<Ctx, In2, DOut, Rd, M> {
    return new Builder<Ctx, In2, DOut, Rd, M>({
      ...(this.state as unknown as State<Ctx, In2>),
      ...patch,
    });
  }
  /**
   * Declare a read. Only reads answer GET, so a cross-site link or `<img src>`
   * can never trigger a mutation. The path is optional: with one, it's also a
   * REST route; without, it's an RPC read (e.g. a file for `urlFor`).
   */
  get(path?: string): Builder<Ctx, In, DOut, true, M> {
    return new Builder<Ctx, In, DOut, true, M>({ ...this.state, method: "GET", path });
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
  /**
   * Expose this procedure to LLMs as a callable tool (opt-in, never default).
   * With `confirm: true`, a tool call only proposes the action: it's stored as
   * pending, and the handler runs when a person approves it (`createApprovals`).
   * A `.stream()` tool's chunks are collected into one result, up to `maxItems`
   * (default 1,000) or `timeoutMs` (default 30 s), so a subscription can't hang
   * the agent; then the handler's signal aborts.
   */
  ai(
    cfg: {
      description?: string;
      confirm?: boolean;
      maxItems?: number;
      timeoutMs?: number;
      annotations?: ToolAnnotations;
    } = {},
  ) {
    if (this.state.noAi) throw new Error("A .noAi() procedure can't also be .ai()");
    if (cfg.annotations?.readOnlyHint && cfg.annotations.destructiveHint) {
      throw new Error(".ai({ annotations }): a tool can't be both readOnlyHint and destructiveHint");
    }
    for (const key of ["maxItems", "timeoutMs"] as const) {
      const v = cfg[key];
      if (v !== undefined && !(Number.isInteger(v) && v > 0)) {
        throw new Error(`.ai({ ${key} }) must be a positive integer, got ${v}`);
      }
    }
    return this.next<In>({
      ai: {
        expose: true,
        description: cfg.description,
        confirm: cfg.confirm === true,
        ...(cfg.maxItems !== undefined ? { maxItems: cfg.maxItems } : {}),
        ...(cfg.timeoutMs !== undefined ? { timeoutMs: cfg.timeoutMs } : {}),
        ...(cfg.annotations ? { annotations: { ...cfg.annotations } } : {}),
      },
    });
  }
  /**
   * Never expose this procedure to a model, even by mistake: combining it with
   * `.ai()` throws where the procedure is defined. `inspectRouter` reports it.
   */
  noAi() {
    if (this.state.ai?.expose) throw new Error("A .ai() procedure can't also be .noAi()");
    return this.next<In>({ noAi: true });
  }
  /**
   * Attach metadata for `inspectRouter` (e.g. `{ restricted: "approver" }`).
   * Typed by `initDendra<Ctx, Meta>()`; repeated calls merge shallowly.
   */
  meta(meta: M) {
    return this.next<In>({ meta: { ...this.state.meta, ...meta } });
  }
  /**
   * Add a middleware. It runs before the handler (across RPC, REST, the caller,
   * WebSocket, and AI/MCP tool execution). Throw a DendraError to reject; return
   * an object to merge it into ctx — the downstream handler sees the enriched,
   * typed context. `inspectRouter` lists it by `opts.name`, else the function's
   * own name, so a test can assert every procedure has its guard.
   */
  use<CtxAdd extends Record<string, unknown> | void>(
    mw: Middleware<Ctx, In, CtxAdd>,
    opts: { name?: string } = {},
  ): Builder<Ctx & (CtxAdd extends void ? unknown : CtxAdd), In, DOut, Rd, M> {
    return new Builder<Ctx & (CtxAdd extends void ? unknown : CtxAdd), In, DOut, Rd, M>({
      ...(this.state as unknown as State<
        Ctx & (CtxAdd extends void ? unknown : CtxAdd),
        In
      >),
      middlewares: [...(this.state.middlewares ?? []), mw as AnyMiddleware],
      middlewareNames: [
        ...(this.state.middlewareNames ?? []),
        opts.name ?? (mw.name || "anonymous"),
      ],
    });
  }
  /**
   * Add an after-hook. It runs once the call settles — success or failure —
   * on every transport, and is awaited before the response goes out. It only
   * runs for calls that passed the middlewares before it, and sees that ctx.
   * Errors thrown in the hook are logged, never returned to the caller.
   */
  after(fn: AfterHook<Ctx, In>) {
    return this.next<In>({
      afterHooks: [
        ...(this.state.afterHooks ?? []),
        { at: this.state.middlewares?.length ?? 0, fn },
      ],
    });
  }
  /**
   * Attach an input schema. Any Standard Schema works (Zod/Valibot/built-in).
   * Calling it again EXTENDS the input (both must be objects): every schema
   * validates the call, and a `.use()` sees the input declared above it — so a
   * shared guard can declare `{ workspaceId }` once, typed and validated.
   */
  input<S extends StandardSchemaV1<unknown, ChainableInput<In>>>(
    schema: S,
  ): Builder<Ctx, ChainedInput<In, InferOutput<S>>, DOut, Rd, M> {
    const { json, missing } = jsonSchemaOf(schema, "input");
    const s = this.state.inputSchema
      ? extendInput(this.state.inputSchema, this.state.inputJsonSchema, schema, json)
      : { inputSchema: schema, inputJsonSchema: json };
    const inputJsonMissing = this.state.inputJsonMissing ?? missing;
    return this.next({ ...s, inputJsonMissing } as Partial<
      State<Ctx, ChainedInput<In, InferOutput<S>>>
    >);
  }
  /**
   * Declare the response shape. Feeds OpenAPI AND constrains the handler's
   * return type to the schema's inferred type — so the output is both documented
   * and type-checked.
   */
  output<S extends StandardSchemaV1>(
    schema: S,
  ): Builder<Ctx, In, InferOutput<S>, Rd, M> {
    return new Builder<Ctx, In, InferOutput<S>, Rd, M>({
      ...this.state,
      outputJsonSchema: jsonSchemaOf(schema, "output").json,
    });
  }
  /** Unary procedure: returns a value. */
  handler<Out>(
    fn: (o: { input: In; ctx: Ctx }) => [DOut] extends [never]
      ? Out | Promise<Out>
      : DOut | Promise<DOut>,
  ): Branded<Proc<Ctx, In, [DOut] extends [never] ? Awaited<Out> : DOut, "unary">, Rd> {
    const s = this.state;
    assertAiCompatible(s, "unary");
    return {
      _dendra: true,
      kind: "unary",
      method: s.method,
      path: s.path,
      description: s.description,
      ai: s.ai,
      noAi: s.noAi,
      inputSchema: s.inputSchema,
      inputJsonSchema: s.inputJsonSchema,
      outputJsonSchema: s.outputJsonSchema,
      middlewares: s.middlewares,
      middlewareNames: s.middlewareNames,
      meta: s.meta,
      afterHooks: s.afterHooks,
      handler: async (input: In, ctx: Ctx) => fn({ input, ctx }),
    } as Branded<Proc<Ctx, In, [DOut] extends [never] ? Awaited<Out> : DOut, "unary">, Rd>;
  }
  /**
   * Streaming procedure: returns an async iterable of elements. `signal` aborts
   * when the consumer goes away — pass it to `pubsub.subscribe` (or check it)
   * so a long-lived subscription stops as soon as the client does.
   */
  stream<Out>(
    fn: (o: { input: In; ctx: Ctx; signal: AbortSignal }) => AsyncIterable<Out>,
  ): Branded<Proc<Ctx, In, Out, "stream">, Rd> {
    const s = this.state;
    assertAiCompatible(s, "stream");
    return {
      _dendra: true,
      kind: "stream",
      method: s.method,
      path: s.path,
      description: s.description,
      ai: s.ai,
      noAi: s.noAi,
      inputSchema: s.inputSchema,
      inputJsonSchema: s.inputJsonSchema,
      outputJsonSchema: s.outputJsonSchema,
      middlewares: s.middlewares,
      middlewareNames: s.middlewareNames,
      meta: s.meta,
      afterHooks: s.afterHooks,
      handler: (input: In, ctx: Ctx, signal?: AbortSignal) =>
        fn({ input, ctx, signal: signal ?? new AbortController().signal }),
    } as Branded<Proc<Ctx, In, Out, "stream">, Rd>;
  }
  /**
   * Background procedure: validates, runs the middlewares, then enqueues `job`
   * and returns `{ jobId }` at once. The job runs later with its own ctx, so
   * use `map` to carry what it needs from this call (tenant, user id).
   */
  background(job: Enqueuer<In>): Branded<Proc<Ctx, In, { jobId: string }, "unary">, Rd>;
  background<J>(
    job: Enqueuer<J>,
    map: (o: { input: In; ctx: Ctx }) => J | Promise<J>,
  ): Branded<Proc<Ctx, In, { jobId: string }, "unary">, Rd>;
  background(
    job: Enqueuer<unknown>,
    map?: (o: { input: In; ctx: Ctx }) => unknown,
  ): Branded<Proc<Ctx, In, { jobId: string }, "unary">, Rd> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (this as Builder<Ctx, In, any, Rd, M>).handler(async ({ input, ctx }) =>
      job.enqueue(map ? await map({ input, ctx }) : input),
    );
  }
}

/** Anything with an `enqueue` (a `Job` from `createJobs`). */
type Enqueuer<I> = { enqueue: (input: I) => Promise<{ jobId: string }> };

/** Bind a context type, then define procedures off `route`. */
export function initDendra<
  Ctx = Record<string, never>,
  Meta extends object = Record<string, unknown>,
>() {
  const route = new Builder<Ctx, void, never, false, Partial<Meta>>({ method: "POST" });
  return { route };
}

export function resolveProc(
  router: RouterRecord,
  segments: string[],
): AnyProc | undefined {
  let cur: AnyProc | RouterRecord | undefined = router;
  for (const seg of segments) {
    if (!cur || (cur as AnyProc)._dendra) return undefined;
    cur = (cur as RouterRecord)[seg];
  }
  return cur && (cur as AnyProc)._dendra ? (cur as AnyProc) : undefined;
}

async function validateInput(proc: AnyProc, raw: unknown): Promise<unknown> {
  if (!proc.inputSchema) return raw;
  const res = await proc.inputSchema["~standard"].validate(raw);
  if (res.issues !== undefined) {
    // Normalise `{ key }` path segments so `details` paths are plain keys.
    const issues = res.issues.map((is) =>
      is.path
        ? {
            ...is,
            path: is.path.map((seg) =>
              typeof seg === "object" && seg !== null ? seg.key : seg,
            ),
          }
        : is,
    );
    throw new DendraError("BAD_REQUEST", "Input validation failed", 400, issues);
  }
  return (res as { value: unknown }).value;
}

// Run the middleware chain: each one may reject (throw) or return a ctx patch
// that is merged in for everything downstream. `seen[i]` records ctx as it was
// before middleware i (and `seen[n]` the final ctx), so after-hooks can tell how
// far a call got and see ctx at their own point in the chain — even on a throw.
async function runMiddleware(
  proc: AnyProc,
  input: unknown,
  ctx: unknown,
  seen: unknown[],
): Promise<unknown> {
  let acc = ctx;
  seen.push(acc);
  for (const mw of proc.middlewares ?? []) {
    const patch = await mw({ ctx: acc, input });
    if (patch && typeof patch === "object") {
      acc = { ...(acc as object), ...(patch as object) };
    }
    seen.push(acc);
  }
  return acc;
}

// Run the after-hooks whose preceding middlewares all passed, in registration
// order. A hook that throws is logged and skipped — it never changes the outcome.
async function runAfterHooks(
  proc: AnyProc,
  site: CallSite,
  input: unknown,
  seen: unknown[],
  started: number,
  outcome: { ok: true; result: unknown } | { ok: false; error: unknown },
): Promise<void> {
  const hooks = proc.afterHooks;
  if (!hooks || hooks.length === 0) return;
  const durationMs = Date.now() - started;
  // Hooks see a file's name/type/size, never its bytes — audit logs stay clean.
  const settled = outcome.ok
    ? {
        ok: true as const,
        result: isFileResult(outcome.result) ? fileMeta(outcome.result) : outcome.result,
      }
    : {
        ok: false as const,
        error: outcome.error,
        code: outcome.error instanceof DendraError ? outcome.error.code : ("INTERNAL" as const),
      };
  for (const { at, fn } of hooks) {
    if (at >= seen.length) continue;
    try {
      await fn({
        ctx: seen[at],
        input,
        path: site.path ?? "",
        transport: site.transport ?? "caller",
        durationMs,
        ...(site.approval ? { approval: site.approval } : {}),
        ...settled,
      });
    } catch (e) {
      console.error(`[dendra] after-hook for '${site.path ?? ""}' threw:`, e);
    }
  }
}

/** Run a unary procedure: validate, run middleware, call the handler, then after-hooks. */
export async function invokeUnary(
  proc: AnyProc,
  raw: unknown,
  ctx: unknown,
  site: CallSite = {},
): Promise<unknown> {
  return invokeWith(proc, raw, ctx, site, (input, ctx2) => proc.handler(input, ctx2));
}

/**
 * `invokeUnary` with `body` in place of the handler — same validation,
 * middleware, and after-hooks. Confirm tools use it to store a proposal, and
 * approvals to run (or refuse) the decided call.
 */
export async function invokeWith(
  proc: AnyProc,
  raw: unknown,
  ctx: unknown,
  site: CallSite,
  body: (input: unknown, ctx: unknown) => unknown,
): Promise<unknown> {
  const input = await validateInput(proc, raw);
  const started = Date.now();
  const seen: unknown[] = [];
  let result: unknown;
  try {
    const ctx2 = await runMiddleware(proc, input, ctx, seen);
    result = await body(input, ctx2);
    rejectFileResult(result, site);
  } catch (error) {
    await runAfterHooks(proc, site, input, seen, started, { ok: false, error });
    throw error;
  }
  await runAfterHooks(proc, site, input, seen, started, { ok: true, result });
  return result;
}

/**
 * Run a streaming procedure: validate, run middleware, yield, then after-hooks
 * once the stream ends (a consumer stopping early counts as success). The
 * handler's signal aborts when `site.signal` does, or when the consumer stops.
 */
export async function* invokeStream(
  proc: AnyProc,
  raw: unknown,
  ctx: unknown,
  site: CallSite = {},
): AsyncIterable<unknown> {
  const input = await validateInput(proc, raw);
  const started = Date.now();
  const seen: unknown[] = [];
  let failure: { error: unknown } | undefined;
  const ac = new AbortController();
  const stop = () => ac.abort(site.signal?.reason);
  if (site.signal?.aborted) stop();
  else site.signal?.addEventListener("abort", stop, { once: true });
  try {
    const ctx2 = await runMiddleware(proc, input, ctx, seen);
    yield* proc.handler(input, ctx2, ac.signal) as AsyncIterable<unknown>;
  } catch (error) {
    failure = { error };
    throw error;
  } finally {
    site.signal?.removeEventListener("abort", stop);
    ac.abort();
    await runAfterHooks(
      proc,
      site,
      input,
      seen,
      started,
      failure ? { ok: false, error: failure.error } : { ok: true, result: undefined },
    );
  }
}
