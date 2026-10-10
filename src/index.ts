// Public surface.
export { initNexus, resolveProc, invokeUnary, invokeStream } from "./core.ts";
export type {
  Proc,
  AnyProc,
  RouterRecord,
  HttpMethod,
  ProcedureKind,
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

export { toToolset, createToolExecutor } from "./tools.ts";
export type { ToolFormat, PlainTool } from "./tools.ts";

export { mcpToolDefinitions, createMcpBridge } from "./mcp.ts";
export type { McpToolDef, McpCallResult } from "./mcp.ts";

export { createInMemoryPubSub } from "./pubsub.ts";
export type { PubSub } from "./pubsub.ts";

export { NexusError, NexusClientError } from "./errors.ts";
export type { ErrorCode } from "./errors.ts";

// Built-in Standard-Schema validators, namespaced as `s`.
export * as s from "./schema.ts";
export type {
  StandardSchemaV1,
  Schema,
  InferInput,
  InferOutput,
  JSONSchema,
} from "./schema.ts";
