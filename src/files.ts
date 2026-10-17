// Files in and out. A file route is just a procedure: `s.file()` validates an
// uploaded File inside an ordinary input object, so the `.use()` chain and
// `.after()` hooks run exactly as for JSON. Types are checked against the file's
// leading bytes where the format has a signature — a header can be forged, the
// bytes can't (cheaply). Web-standard File/Blob only; no dependencies.

import type { JSONSchema, Schema, StandardResult } from "./schema.ts";
import { DendraError } from "./errors.ts";

// ── Byte signatures ────────────────────────────────────────────────────────

const SIGNATURES: ReadonlyArray<{ type: string; test: (b: Uint8Array) => boolean }> = [
  { type: "image/png", test: (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  { type: "image/jpeg", test: (b) => startsWith(b, [0xff, 0xd8, 0xff]) },
  { type: "image/gif", test: (b) => ascii(b, 0, "GIF87a") || ascii(b, 0, "GIF89a") },
  { type: "image/webp", test: (b) => ascii(b, 0, "RIFF") && ascii(b, 8, "WEBP") },
  { type: "application/pdf", test: (b) => ascii(b, 0, "%PDF-") },
  { type: "application/zip", test: (b) => startsWith(b, [0x50, 0x4b, 0x03, 0x04]) },
];
const SIGNED = new Set(SIGNATURES.map((s) => s.type));

function startsWith(b: Uint8Array, sig: number[]): boolean {
  return b.length >= sig.length && sig.every((x, i) => b[i] === x);
}
function ascii(b: Uint8Array, at: number, s: string): boolean {
  return b.length >= at + s.length && [...s].every((c, i) => b[at + i] === c.charCodeAt(0));
}

/** The type a file's leading bytes identify it as, if it has a known signature. */
export function sniffType(bytes: Uint8Array): string | undefined {
  return SIGNATURES.find((s) => s.test(bytes))?.type;
}

// ── s.file() ───────────────────────────────────────────────────────────────

export interface FileSchemaOptions {
  /** MIME types (`"image/png"`) and/or filename extensions (`".csv"`). Omit for any. */
  types?: string[];
  /** Per-file size cap in bytes. */
  maxBytes?: number;
}

export interface FileSchema extends Schema<File> {
  describe(description: string): FileSchema;
}

export const FILE_MARKER = "x-dendra-file";

export function fileSchema(opts: FileSchemaOptions = {}, description?: string): FileSchema {
  const mimes = (opts.types ?? []).filter((t) => !t.startsWith(".")).map((t) => t.toLowerCase());
  const exts = (opts.types ?? []).filter((t) => t.startsWith(".")).map((t) => t.toLowerCase());
  const jsonSchema: JSONSchema = { type: "string", format: "binary", [FILE_MARKER]: true };
  if (mimes.length === 1 && exts.length === 0) jsonSchema.contentMediaType = mimes[0];
  if (opts.maxBytes !== undefined) jsonSchema.maxLength = opts.maxBytes;
  if (description) jsonSchema.description = description;

  const fail = (message: string): StandardResult<never> => ({ issues: [{ message }] });

  return {
    "~standard": {
      version: 1,
      vendor: "dendra",
      async validate(v) {
        if (!(v instanceof Blob)) return fail("expected a file");
        const f = v instanceof File ? v : new File([v], "blob", { type: v.type });
        if (opts.maxBytes !== undefined && f.size > opts.maxBytes) {
          return fail(`file is ${f.size} bytes; the limit is ${opts.maxBytes}`);
        }
        if (!opts.types || opts.types.length === 0) return { value: f };

        const declared = f.type.split(";")[0].trim().toLowerCase();
        const allowed = [...mimes, ...exts].join(", ");
        if (SIGNED.has(declared)) {
          // A type with a signature must be backed by matching bytes.
          const sniffed = sniffType(new Uint8Array(await f.slice(0, 16).arrayBuffer()));
          if (sniffed !== declared) {
            return fail(`expected ${allowed}; got bytes of ${sniffed ?? "an unknown type"}`);
          }
          if (!mimes.includes(declared)) return fail(`expected ${allowed}; got ${declared}`);
          return { value: f };
        }
        const name = f.name.toLowerCase();
        if (mimes.includes(declared) || exts.some((e) => name.endsWith(e))) return { value: f };
        return fail(`expected ${allowed}; got ${declared || "no type"} (${f.name})`);
      },
    },
    jsonSchema,
    describe: (d) => fileSchema(opts, d),
  };
}

/** True for the JSON Schema `s.file()` emits. */
export function isFileSchema(js: JSONSchema | undefined): boolean {
  return js?.[FILE_MARKER] === true;
}

/** Top-level input fields that are files (files only live at the top level). */
export function fileFields(inputJsonSchema: JSONSchema | undefined): string[] {
  const props = inputJsonSchema?.properties ?? {};
  return Object.keys(props).filter((k) => isFileSchema(props[k]));
}

// ── Reading uploads ────────────────────────────────────────────────────────

/** Default cap on a multipart or form request body: 10 MB. */
export const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024;

function tooLarge(max: number): DendraError {
  return new DendraError("PAYLOAD_TOO_LARGE", `Request body exceeds ${max} bytes`);
}

// Read a body, failing as soon as it passes `max` — the declared Content-Length
// is checked first, and the count is enforced while reading, so a chunked
// upload can't slip past the cap or make the server buffer it.
export async function limitedBytes(req: Request, max: number): Promise<Uint8Array> {
  const declared = Number(req.headers.get("content-length"));
  if (declared > max) throw tooLarge(max);
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      throw tooLarge(max);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/**
 * Turn a multipart or urlencoded request into a procedure input. dendra's
 * client sends non-file fields as one JSON part named `$input` and each file as
 * its own part; a plain form (no `$input`) contributes its string fields as-is.
 * The caller has already done the CSRF check (see `csrfReject` in server.ts).
 */
export async function readFormInput(
  req: Request,
  maxBodyBytes: number,
): Promise<Record<string, unknown>> {
  const bytes = await limitedBytes(req, maxBodyBytes);
  let form: FormData;
  try {
    form = await new Response(bytes, {
      headers: { "content-type": req.headers.get("content-type") ?? "" },
    }).formData();
  } catch {
    throw new DendraError("BAD_REQUEST", "Malformed form body");
  }
  const json = form.get("$input");
  let input: Record<string, unknown> = {};
  if (typeof json === "string") {
    try {
      const parsed = JSON.parse(json) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        input = parsed as Record<string, unknown>;
      }
    } catch {
      throw new DendraError("BAD_REQUEST", "Invalid JSON in $input");
    }
  }
  for (const [k, v] of form.entries()) {
    if (k === "$input") continue;
    if (typeof v !== "string") input[k] = v;
    else if (json === null) input[k] = v;
  }
  return input;
}

// ── file() outputs ─────────────────────────────────────────────────────────

export interface FileOptions {
  /** The response's Content-Type. */
  type: string;
  /** Download name for Content-Disposition (sanitized before it's sent). */
  filename?: string;
  /** Show in the browser rather than download. Ignored for active types. */
  inline?: boolean;
  /** Default `private, no-store` — tenant data stays out of shared caches. */
  cacheControl?: string;
  /** Sent as `ETag`; a matching `If-None-Match` gets a bodiless 304. */
  etag?: string;
  /** Allow `inline` for HTML/SVG/XML. Only for content you fully control. */
  allowUnsafeInline?: boolean;
  /** Extra headers. Can't override Content-Type/-Disposition or nosniff. */
  headers?: Record<string, string>;
}

export type FileBody = Blob | ReadableStream<Uint8Array> | ArrayBuffer | Uint8Array | string;
type ResponseBody = ConstructorParameters<typeof Response>[0];

/** What `file()` returns. Servers send it raw; clients and callers see a Blob. */
export interface FileResult {
  readonly _dendraFile: true;
  readonly body: FileBody;
  readonly options: FileOptions;
}

/** Return a file from a handler: sent as a raw response, not JSON. */
export function file(body: FileBody, options: FileOptions): FileResult {
  return { _dendraFile: true, body, options };
}

export function isFileResult(v: unknown): v is FileResult {
  return typeof v === "object" && v !== null && (v as FileResult)._dendraFile === true;
}

function sizeOf(body: FileBody): number | undefined {
  if (typeof body === "string") return new TextEncoder().encode(body).byteLength;
  if (body instanceof Blob) return body.size;
  if (body instanceof ArrayBuffer || body instanceof Uint8Array) return body.byteLength;
  return undefined; // a stream's length isn't known up front
}

/** What `.after()` hooks see instead of a FileResult — never the bytes. */
export function fileMeta(f: FileResult): {
  file: { type: string; filename?: string; size?: number };
} {
  const meta: { type: string; filename?: string; size?: number } = { type: f.options.type };
  if (f.options.filename !== undefined) meta.filename = f.options.filename;
  const size = sizeOf(f.body);
  if (size !== undefined) meta.size = size;
  return { file: meta };
}

/** The Blob a caller gets for a FileResult. */
export async function toBlob(f: FileResult): Promise<Blob> {
  if (f.body instanceof Blob) return f.body;
  return new Blob([await new Response(f.body as ResponseBody).arrayBuffer()], {
    type: f.options.type,
  });
}

// Types a browser executes as a document on our origin when shown inline.
const ACTIVE_TYPES = new Set([
  "text/html",
  "application/xhtml+xml",
  "image/svg+xml",
  "text/xml",
  "application/xml",
]);
function isActive(type: string): boolean {
  const t = type.split(";")[0].trim().toLowerCase();
  return ACTIVE_TYPES.has(t) || t.endsWith("+xml");
}

// RFC 6266: a quoted ASCII fallback plus the exact name in RFC 5987 `filename*`.
// The fallback drops quotes, backslashes and control characters (no header
// injection, no broken quoting); non-ASCII becomes "_".
function disposition(kind: "inline" | "attachment", name: string): string {
  const ascii =
    name
      .replace(/[\x00-\x1f\x7f"\\]/g, "")
      .replace(/[^\x20-\x7e]/g, "_") || "download";
  const exact = encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${exact}`;
}

const PROTECTED = new Set(["content-type", "content-disposition", "x-content-type-options", "x-dendra"]);

function etagMatches(header: string | null, etag: string): boolean {
  if (!header) return false;
  return header.split(",").some((part) => {
    const t = part.trim().replace(/^W\//, "").replace(/^"|"$/g, "");
    return t === "*" || t === etag;
  });
}

/** Build the raw HTTP response for a FileResult. */
export function fileResponse(f: FileResult, req: Request): Response {
  const o = f.options;
  const headers = new Headers();
  for (const [k, v] of Object.entries(o.headers ?? {})) {
    if (!PROTECTED.has(k.toLowerCase())) headers.set(k, v);
  }
  headers.set("content-type", o.type);
  headers.set("cache-control", o.cacheControl ?? "private, no-store");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-dendra", "file");

  const inline = o.inline === true && (!isActive(o.type) || o.allowUnsafeInline === true);
  if (o.filename !== undefined) {
    headers.set("content-disposition", disposition(inline ? "inline" : "attachment", o.filename));
  } else if (!inline) {
    headers.set("content-disposition", "attachment");
  }

  if (o.etag !== undefined) {
    const etag = o.etag.replace(/["\x00-\x1f\x7f]/g, "");
    headers.set("etag", `"${etag}"`);
    if (etagMatches(req.headers.get("if-none-match"), etag)) {
      return new Response(null, { status: 304, headers });
    }
  }
  return new Response(f.body as ResponseBody, { status: 200, headers });
}
