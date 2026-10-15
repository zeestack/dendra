// Typed errors that cross the wire as `{ code, message, details }` and map to
// HTTP status codes. The client re-throws a DendraClientError, so error handling
// is symmetric on both sides.

export type ErrorCode =
  | "BAD_REQUEST"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "UNPROCESSABLE"
  | "TOO_MANY_REQUESTS"
  | "INTERNAL"
  | "NOT_IMPLEMENTED";

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UNPROCESSABLE: 422,
  TOO_MANY_REQUESTS: 429,
  INTERNAL: 500,
  NOT_IMPLEMENTED: 501,
};

export class DendraError extends Error {
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
    this.name = "DendraError";
    this.code = code;
    this.status = status ?? STATUS_BY_CODE[code];
    this.details = details;
  }
}

export class DendraClientError extends Error {
  readonly code: string;
  readonly details?: unknown;
  constructor(e: { code?: string; message?: string; details?: unknown }) {
    super(e.message ?? "Request failed");
    this.name = "DendraClientError";
    this.code = e.code ?? "INTERNAL";
    this.details = e.details;
  }
}
