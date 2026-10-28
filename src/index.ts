// Public surface.
import {
  resolveProc as resolveProc_,
  invokeUnary as invokeUnary_,
  invokeStream as invokeStream_,
} from "./core.ts";
import type {
  Proc as Proc_,
  AnyProc as AnyProc_,
  CallSite as CallSite_,
  Transport as Transport_,
  ProcedureKind as ProcedureKind_,
} from "./core.ts";
import {
  createMemoryStore as createMemoryStore_,
  recallMemory as recallMemory_,
  rememberFacts as rememberFacts_,
  formatMemoryBlock as formatMemoryBlock_,
} from "./memory.ts";

export { initDendra } from "./core.ts";
export type {
  RouterRecord,
  HttpMethod,
  Middleware,
  AfterHook,
  AfterInfo,
  ReadBrand,
  Approval,
  AiConfig,
} from "./core.ts";

// Moved to `dendra/adapter` in 0.12. These aliases go in 0.13.
/** @deprecated Import from "dendra/adapter". Removed in 0.13. */
export const resolveProc = resolveProc_;
/** @deprecated Import from "dendra/adapter". Removed in 0.13. */
export const invokeUnary = invokeUnary_;
/** @deprecated Import from "dendra/adapter". Removed in 0.13. */
export const invokeStream = invokeStream_;
/** @deprecated Import from "dendra/adapter". Removed in 0.13. */
export type Proc<Ctx = unknown, In = unknown, Out = unknown, K extends ProcedureKind_ = "unary"> =
  Proc_<Ctx, In, Out, K>;
/** @deprecated Import from "dendra/adapter". Removed in 0.13. */
export type AnyProc = AnyProc_;
/** @deprecated Import from "dendra/adapter". Removed in 0.13. */
export type CallSite = CallSite_;
/** @deprecated Import from "dendra/adapter". Removed in 0.13. */
export type Transport = Transport_;
/** @deprecated Import from "dendra/adapter". Removed in 0.13. */
export type ProcedureKind = ProcedureKind_;

export {
  createApprovals,
  createInMemoryApprovalStore,
  isPendingResult,
} from "./approvals.ts";
export type {
  Approvals,
  ApprovalsOptions,
  ApprovalStore,
  PendingAction,
  PendingResult,
} from "./approvals.ts";

export { inspectRouter } from "./inspect.ts";
export type { RouteInfo } from "./inspect.ts";

export { createCaller } from "./caller.ts";
export { file } from "./files.ts";
export type { FileOptions, FileResult, FileBody } from "./files.ts";
export type { CallOptions, Caller, Client, Jsonify } from "./caller.ts";

export { toFetchHandler, toNodeHandler, toRestHandler } from "./server.ts";
export type { ServerOptions } from "./server.ts";
export { toNextHandler } from "./adapters.ts";

export { toOpenApiDocument } from "./openapi.ts";
export type { OpenApiInfo, OpenApiOptions } from "./openapi.ts";

export {
  createWsSession,
  createWsClient,
  attachWs,
  connectWs,
} from "./ws.ts";
export type {
  WsSession,
  WsClient,
  WsLikeSocket,
  WhatwgSocket,
} from "./ws.ts";
export { attachWsServer } from "./ws-server.ts";
export { createWsConnection } from "./ws-connection.ts";
export type {
  WsConnection,
  WsConnectionOptions,
  WsBrowserSocket,
  WsStatus,
} from "./ws-connection.ts";
export type {
  WsServerOptions,
  WsServerHandle,
  WsServerLike,
  WsServerSocket,
  WsUpgradeRequest,
  WsUpgradeSocket,
} from "./ws-server.ts";

export { createClient, urlFor } from "./client.ts";
export type { ClientOptions } from "./client.ts";

export {
  toToolset,
  createToolExecutor,
  formatTool,
  toToolSource,
  mergeToolsets,
} from "./tools.ts";
export type { ToolFormat, PlainTool, ToolSource } from "./tools.ts";

// Tool-context management: defer a large toolset behind a search_tools meta-tool.
export { lazyToolset } from "./context.ts";
export type { LazyToolset, LazyToolsetOptions } from "./context.ts";

// The unified context layer: one budget over memory recall, lazy tools, and
// history. `runAgent({ context })` drives it; sources wrap the existing pieces.
export {
  createContextManager,
  memorySource,
  lazyToolSource,
  toolSource,
} from "./context-manager.ts";
export type {
  ContextManager,
  ContextManagerOptions,
  ContextSource,
  Turn,
  Budget,
  Loaded,
  PreparedContext,
  MemorySourceOptions,
  LazyToolSourceOptions,
  ToolSourceOptions,
} from "./context-manager.ts";

export { mcpToolDefinitions, createMcpBridge, createMcpToolSource, createMcpRouter } from "./mcp.ts";
export type {
  McpToolDef,
  McpCallResult,
  McpClientLike,
  McpToolSourceOptions,
  McpRouterOptions,
} from "./mcp.ts";

export { createInMemoryPubSub, createPubSub } from "./pubsub.ts";
export type { PubSub, PubSubTransport } from "./pubsub.ts";
export { createRedisPubSub } from "./redis-pubsub.ts";
export type { RedisPubSubClient } from "./redis-pubsub.ts";
export { createPgPubSub } from "./pg-pubsub.ts";
export type {
  PgPubSub,
  PgPubSubOptions,
  PgPool,
  PgListenClient,
  PgNotification,
} from "./pg-pubsub.ts";
export { createJobs, createInMemoryJobStore } from "./jobs.ts";
export { followJob } from "./follow-job.ts";
export type { FollowedJob, FollowJobOptions, JobConnection, JobFollower, JobSnapshotLike } from "./follow-job.ts";
export type {
  Jobs,
  JobsOptions,
  Job,
  JobOptions,
  JobHandle,
  JobSnapshot,
  JobStatus,
  JobError,
  JobStore,
  JobRecord,
  NewJob,
  JobSettlement,
  JobStopOptions,
  JobStopResult,
} from "./jobs.ts";
export type { JobCalendar, NewSchedule, ScheduleRecord, JobScheduleStore } from "./job-schedules.ts";
export { createPgJobStore } from "./pg-job-store.ts";
export type { PgJobStore, PgQueryable } from "./pg-job-store.ts";

export { DendraError, DendraClientError } from "./errors.ts";
export type { ErrorCode } from "./errors.ts";

// Shared agent types. The agentic loop (`dendra/anthropic`) and the React hook
// (`dendra/react`) are optional subpath exports (they pull in peer deps), but the
// part type they exchange is dependency-free and lives in core.
export type {
  AgentPart,
  AgentTextPart,
  AgentToolPart,
  AgentMemoryPart,
  AgentContextPart,
} from "./agent.ts";

// Memory: the store interface lives here so you can type `ctx.memory`; the
// functions are in `dendra/memory`. These aliases go in 0.13.
export type { MemoryStore, MemoryRecord, RecallOptions } from "./memory.ts";
/** @deprecated Import from "dendra/memory". Removed in 0.13. */
export const createMemoryStore = createMemoryStore_;
/** @deprecated Import from "dendra/memory". Removed in 0.13. */
export const recallMemory = recallMemory_;
/** @deprecated Import from "dendra/memory". Removed in 0.13. */
export const rememberFacts = rememberFacts_;
/** @deprecated Import from "dendra/memory". Removed in 0.13. */
export const formatMemoryBlock = formatMemoryBlock_;

// Built-in Standard-Schema validators, namespaced as `s`.
export * as s from "./schema.ts";
export type {
  StandardSchemaV1,
  Schema,
  InferInput,
  InferOutput,
  JSONSchema,
} from "./schema.ts";
