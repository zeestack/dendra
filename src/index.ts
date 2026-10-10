// Public surface.
export { initDendra, resolveProc, invokeUnary, invokeStream } from "./core.ts";
export type {
  Proc,
  AnyProc,
  RouterRecord,
  HttpMethod,
  ProcedureKind,
  Middleware,
} from "./core.ts";

export { createCaller } from "./caller.ts";
export type { Client } from "./caller.ts";

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

export { createClient } from "./client.ts";
export type { ClientOptions } from "./client.ts";

export {
  toToolset,
  createToolExecutor,
  formatTool,
  toToolSource,
  mergeToolsets,
} from "./tools.ts";
export type { ToolFormat, PlainTool, ToolSource } from "./tools.ts";

export { mcpToolDefinitions, createMcpBridge, createMcpToolSource } from "./mcp.ts";
export type {
  McpToolDef,
  McpCallResult,
  McpClientLike,
  McpToolSourceOptions,
} from "./mcp.ts";

export { createInMemoryPubSub } from "./pubsub.ts";
export type { PubSub } from "./pubsub.ts";
export { createRedisPubSub } from "./redis-pubsub.ts";
export type { RedisPubSubClient } from "./redis-pubsub.ts";

export { DendraError, DendraClientError } from "./errors.ts";
export type { ErrorCode } from "./errors.ts";

// Shared agent types. The agentic loop (`dendra/anthropic`) and the React hook
// (`dendra/react`) are optional subpath exports (they pull in peer deps), but the
// part type they exchange is dependency-free and lives in core.
export type { AgentPart, AgentTextPart, AgentToolPart } from "./agent.ts";

// Built-in Standard-Schema validators, namespaced as `s`.
export * as s from "./schema.ts";
export type {
  StandardSchemaV1,
  Schema,
  InferInput,
  InferOutput,
  JSONSchema,
} from "./schema.ts";
