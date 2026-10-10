// The streamed "parts" of an assistant turn. Text parts render as text; tool
// parts render a React component chosen by `name` (see the client registry).
// Shared by server (what it yields) and client (what it renders) — one type,
// so the generative-UI contract is typesafe end to end.

export type ChatPart =
  | { type: "text"; text: string }
  | {
      type: "tool";
      name: string;
      input: unknown;
      result: unknown;
      isError?: boolean;
    };
