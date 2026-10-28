// Shared types for the optional agent helpers. These are plain types with no
// runtime and no dependencies, so core stays dep-free. The two optional helpers
// — `dendra/anthropic` (runAgent) and `dendra/react` (useAssistant) — speak this
// same `AgentPart` shape, which is what lets them snap together: the loop emits
// parts, the hook renders them, and the contract is typed end to end.

import type { MemoryRecord } from "./memory.ts";

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
  /** Set when the tool needs approval: the pending action to approve or reject. */
  approvalId?: string;
}

/**
 * A memory read or write that happened during the turn — renderable like a tool
 * call (e.g. a "🧠 recalled 3 facts" chip). `op: "recalled"` carries the hits
 * injected before the model ran; `op: "saved"` carries newly persisted facts.
 */
export interface AgentMemoryPart {
  type: "memory";
  op: "recalled" | "saved";
  records: MemoryRecord[];
}

/**
 * A context-layer event from a `ContextManager` (unified memory + tools + …).
 * Generalizes `AgentMemoryPart`: `source` names the origin ("memory", "tools", …)
 * and `op` is what happened — `"recalled"`/`"saved"` carry memory `records`,
 * `"loaded"` carries the `tools` names un-deferred into the live set.
 */
export interface AgentContextPart {
  type: "context";
  source: string;
  op: "recalled" | "loaded" | "saved";
  records?: MemoryRecord[];
  tools?: string[];
}

/** One streamed part of an assistant turn. */
export type AgentPart =
  | AgentTextPart
  | AgentToolPart
  | AgentMemoryPart
  | AgentContextPart;
