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

const FILE_MARKER = "x-dendra-file";

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
