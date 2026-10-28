// Typed errors that cross the wire as `{ code, message, details }` and map to
// HTTP status codes. The client re-throws a DendraClientError, so error handling
// is symmetric on both sides.

export type ErrorCode =
  | "BAD_REQUEST"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "METHOD_NOT_ALLOWED"
  | "CONFLICT"
  | "PAYLOAD_TOO_LARGE"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "UNPROCESSABLE"
  | "TOO_MANY_REQUESTS"
  | "INTERNAL"
  | "NOT_IMPLEMENTED"
  | "BAD_GATEWAY";

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  UNPROCESSABLE: 422,
  TOO_MANY_REQUESTS: 429,
  INTERNAL: 500,
  NOT_IMPLEMENTED: 501,
  BAD_GATEWAY: 502,
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

/**
 * What a caller (a browser, a WebSocket client, an MCP client, the model) sees
 * of a thrown error. A `DendraError` is the app's deliberate message and passes
 * through; anything else becomes a bare INTERNAL, since its message can carry
 * internals (SQL, file paths, hostnames, keys). Callers log the original.
 */
export function publicError(e: unknown): { code: ErrorCode; message: string; details?: unknown } {
  if (e instanceof DendraError) {
    return e.details === undefined
      ? { code: e.code, message: e.message }
      : { code: e.code, message: e.message, details: e.details };
  }
  return { code: "INTERNAL", message: "Internal error" };
}
