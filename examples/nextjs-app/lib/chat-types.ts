// The streamed "parts" of an assistant turn, shared by server (what it yields)
// and client (what it renders). This IS the framework's AgentPart — `runAgent`
// (dendra/anthropic) emits it and `useAssistant` (dendra/react) consumes it — so
// the generative-UI contract is one type, end to end.

export type { AgentPart as ChatPart } from "dendra";
