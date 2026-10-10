// Shared types for the optional agent helpers. These are plain types with no
// runtime and no dependencies, so core stays dep-free. The two optional helpers
// — `dendra/anthropic` (runAgent) and `dendra/react` (useAssistant) — speak this
// same `AgentPart` shape, which is what lets them snap together: the loop emits
// parts, the hook renders them, and the contract is typed end to end.

/** A streamed chunk of assistant text. */
export interface AgentTextPart {
  type: "text";
  text: string;
}

/** A tool the model called, with its result — the generative-UI event. */
export interface AgentToolPart {
  type: "tool";
  name: string;
  input: unknown;
  result: unknown;
  isError?: boolean;
}

/** One streamed part of an assistant turn. */
export type AgentPart = AgentTextPart | AgentToolPart;
