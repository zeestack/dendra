// Typed errors that cross the wire as `{ code, message, details }` and map to
// HTTP status codes. The client re-throws a NexusClientError, so error handling
// is symmetric on both sides.

export type ErrorCode =
  | "BAD_REQUEST"
  | "NOT_FOUND"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "INTERNAL";

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  INTERNAL: 500,
};

export class NexusError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;
  constructor(
    code: ErrorCode,
    message: string,
    status?: number,
    details?: unknown,
  ) {
    super(message);
    this.name = "NexusError";
    this.code = code;
    this.status = status ?? STATUS_BY_CODE[code];
    this.details = details;
  }
}

export class NexusClientError extends Error {
  readonly code: string;
  readonly details?: unknown;
  constructor(e: { code?: string; message?: string; details?: unknown }) {
    super(e.message ?? "Request failed");
    this.name = "NexusClientError";
    this.code = e.code ?? "INTERNAL";
    this.details = e.details;
  }
}
