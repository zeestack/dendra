// dendra/adapter — the dispatch core, for people writing a new transport (a
// queue consumer, a custom socket protocol, a test harness). Apps don't need
// it: `toFetchHandler`, `createCaller`, the WebSocket server and the tool
// executor already sit on top of these.
//
// @experimental Outside the 1.0 stability guarantee: middleware order, after-hook
// timing and the `CallSite` shape may change in a minor release.

export { resolveProc, invokeUnary, invokeStream } from "./core.ts";
export type { Proc, AnyProc, CallSite, Transport, ProcedureKind } from "./core.ts";
