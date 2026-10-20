// Minimal, zero-dependency validators that conform to the Standard Schema spec
// (https://standardschema.dev). Because they speak `~standard`, the framework
// can also accept Zod / Valibot / ArkType schemas interchangeably — nothing in
// core depends on this file. Each built-in schema additionally carries a
// `jsonSchema`, which is what powers OpenAPI generation and AI tool definitions —
// so richer constraints here mean richer OpenAPI specs AND more accurate model
// tool calls.

import { registerObjectShape, type UnknownKeyMode } from "./object-shape.ts";

/** The spec lets a path segment be a bare key or `{ key }` (Zod, Valibot, … use both). */
export interface StandardPathSegment {
  readonly key: PropertyKey;
}

export interface StandardIssue {
  readonly message: string;
  readonly path?: ReadonlyArray<PropertyKey | StandardPathSegment> | undefined;
}

export type StandardResult<T> =
  | { readonly value: T; readonly issues?: undefined }
  | { readonly issues: ReadonlyArray<StandardIssue>; readonly value?: undefined };

export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown,
    ) => StandardResult<Output> | Promise<StandardResult<Output>>;
    readonly types?: { readonly input: Input; readonly output: Output } | undefined;
  };
}

export type InferInput<S> =
  S extends StandardSchemaV1<infer I, unknown> ? I : never;
export type InferOutput<S> =
  S extends StandardSchemaV1<unknown, infer O> ? O : never;

export interface JSONSchema {
  type?: string | string[];
  properties?: Record<string, JSONSchema>;
  required?: ReadonlyArray<string>;
  items?: JSONSchema;
  description?: string;
  enum?: ReadonlyArray<unknown>;
  const?: unknown;
  anyOf?: ReadonlyArray<JSONSchema>;
  additionalProperties?: boolean | JSONSchema;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: string;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  [k: string]: unknown;
}

export interface Schema<T> extends StandardSchemaV1<T, T> {
  readonly jsonSchema: JSONSchema;
  readonly isOptional?: boolean;
  describe(description: string): Schema<T>;
}

export interface OptionalSchema<T> extends Schema<T | undefined> {
  readonly isOptional: true;
}

// A single constraint: returns an error message when `v` fails, else undefined.
type Check<T> = (v: T) => string | undefined;

function ok<T>(value: T): StandardResult<T> {
  return { value };
}
function fail(message: string, path?: PropertyKey[]): StandardResult<never> {
  return { issues: [{ message, path }] };
}
function isFailure<T>(
  r: StandardResult<T>,
): r is { issues: ReadonlyArray<StandardIssue>; value?: undefined } {
  return (r as { issues?: unknown }).issues !== undefined;
}

// The runtime "type" of a value, for readable error messages.
function received(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

// ── Scalars with fluent constraints ────────────────────────────────────────

// Builds a synchronous, guarded, refinable validator shared by scalar types.
function scalar<T>(
  guard: (v: unknown) => v is T,
  typeName: string,
  jsonSchema: JSONSchema,
  checks: ReadonlyArray<Check<T>>,
  isOptional = false,
): Schema<T> {
  return {
    "~standard": {
      version: 1,
      vendor: "dendra",
      validate(v) {
        if (!guard(v)) {
          return fail(`Expected ${typeName}, received ${received(v)}`);
        }
        for (const c of checks) {
          const m = c(v);
          if (m) return fail(m);
        }
        return ok(v);
      },
    },
    jsonSchema,
    isOptional,
    describe(description) {
      return scalar(
        guard,
        typeName,
        { ...jsonSchema, description },
        checks,
        isOptional,
      );
    },
  };
}

const isString = (v: unknown): v is string => typeof v === "string";
const isNumber = (v: unknown): v is number =>
  typeof v === "number" && !Number.isNaN(v);

export interface StringSchema extends Schema<string> {
  min(length: number, message?: string): StringSchema;
  max(length: number, message?: string): StringSchema;
  length(length: number, message?: string): StringSchema;
  pattern(re: RegExp, message?: string): StringSchema;
  email(message?: string): StringSchema;
  uuid(message?: string): StringSchema;
  url(message?: string): StringSchema;
  describe(description: string): StringSchema;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function stringSchema(
  jsonSchema: JSONSchema,
  checks: ReadonlyArray<Check<string>>,
): StringSchema {
  const base = scalar<string>(isString, "string", jsonSchema, checks);
  const next = (js: JSONSchema, c: Check<string>): StringSchema =>
    stringSchema(js, [...checks, c]);
  return {
    ...base,
    min: (n, m) =>
      next({ ...jsonSchema, minLength: n }, (v) =>
        v.length >= n ? undefined : (m ?? `Must be at least ${n} characters`),
      ),
    max: (n, m) =>
      next({ ...jsonSchema, maxLength: n }, (v) =>
        v.length <= n ? undefined : (m ?? `Must be at most ${n} characters`),
      ),
    length: (n, m) =>
      next({ ...jsonSchema, minLength: n, maxLength: n }, (v) =>
        v.length === n ? undefined : (m ?? `Must be exactly ${n} characters`),
      ),
    pattern: (re, m) =>
      next({ ...jsonSchema, pattern: re.source }, (v) =>
        re.test(v) ? undefined : (m ?? `Must match ${re}`),
      ),
    email: (m) =>
      next({ ...jsonSchema, format: "email" }, (v) =>
        EMAIL_RE.test(v) ? undefined : (m ?? "Must be a valid email"),
      ),
    uuid: (m) =>
      next({ ...jsonSchema, format: "uuid" }, (v) =>
        UUID_RE.test(v) ? undefined : (m ?? "Must be a valid UUID"),
      ),
    url: (m) =>
      next({ ...jsonSchema, format: "uri" }, (v) => {
        try {
          new URL(v);
          return undefined;
        } catch {
          return m ?? "Must be a valid URL";
        }
      }),
    describe: (description) => stringSchema({ ...jsonSchema, description }, checks),
  };
}

export function string(): StringSchema {
  return stringSchema({ type: "string" }, []);
}

export interface NumberSchema extends Schema<number> {
  min(value: number, message?: string): NumberSchema;
  max(value: number, message?: string): NumberSchema;
  int(message?: string): NumberSchema;
  describe(description: string): NumberSchema;
}

function numberSchema(
  jsonSchema: JSONSchema,
  checks: ReadonlyArray<Check<number>>,
): NumberSchema {
  const base = scalar<number>(isNumber, "number", jsonSchema, checks);
  const next = (js: JSONSchema, c: Check<number>): NumberSchema =>
    numberSchema(js, [...checks, c]);
  return {
    ...base,
    min: (n, m) =>
      next({ ...jsonSchema, minimum: n }, (v) =>
        v >= n ? undefined : (m ?? `Must be >= ${n}`),
      ),
    max: (n, m) =>
      next({ ...jsonSchema, maximum: n }, (v) =>
        v <= n ? undefined : (m ?? `Must be <= ${n}`),
      ),
    int: (m) =>
      next({ ...jsonSchema, type: "integer" }, (v) =>
        Number.isInteger(v) ? undefined : (m ?? "Must be an integer"),
      ),
    describe: (description) => numberSchema({ ...jsonSchema, description }, checks),
  };
}

export function number(): NumberSchema {
  return numberSchema({ type: "number" }, []);
}

export function integer(): NumberSchema {
  return numberSchema({ type: "integer" }, [
    (v) => (Number.isInteger(v) ? undefined : "Must be an integer"),
  ]);
}

export function boolean(): Schema<boolean> {
  return scalar<boolean>(
    (v): v is boolean => typeof v === "boolean",
    "boolean",
    { type: "boolean" },
    [],
  );
}

// ── Literals, enums, unions, null ──────────────────────────────────────────

export function literal<const V extends string | number | boolean>(
  value: V,
): Schema<V> {
  return scalar<V>(
    (v): v is V => v === value,
    JSON.stringify(value),
    { const: value },
    [],
  );
}

// Exported below as `s.enum`.
function enumSchema<const T extends readonly [unknown, ...unknown[]]>(
  values: T,
): Schema<T[number]> {
  const set = new Set(values);
  const label = values.map((v) => JSON.stringify(v)).join(" | ");
  return scalar<T[number]>(
    (v): v is T[number] => set.has(v),
    label,
    { enum: [...values] },
    [],
  );
}

// Exported below as `s.null`.
function nullSchema(): Schema<null> {
  return scalar<null>((v): v is null => v === null, "null", { type: "null" }, []);
}

type OutputOf<S> = S extends Schema<infer T> ? T : never;

export function union<T extends ReadonlyArray<Schema<unknown>>>(
  schemas: [...T],
): Schema<OutputOf<T[number]>> {
  return {
    "~standard": {
      version: 1,
      vendor: "dendra",
      async validate(v) {
        for (const s of schemas) {
          const r = await s["~standard"].validate(v);
          if (!isFailure(r)) return ok(r.value as OutputOf<T[number]>);
        }
        return fail(`Did not match any allowed variant (received ${received(v)})`);
      },
    },
    jsonSchema: { anyOf: schemas.map((s) => s.jsonSchema) },
    describe(description) {
      const self = union(schemas);
      return { ...self, jsonSchema: { ...self.jsonSchema, description } };
    },
  };
}

export function nullable<T>(inner: Schema<T>): Schema<T | null> {
  return {
    "~standard": {
      version: 1,
      vendor: "dendra",
      validate(v) {
        if (v === null) return ok(null);
        return inner["~standard"].validate(v) as
          | StandardResult<T | null>
          | Promise<StandardResult<T | null>>;
      },
    },
    jsonSchema: { anyOf: [inner.jsonSchema, { type: "null" }] },
    describe(description) {
      const self = nullable(inner);
      return { ...self, jsonSchema: { ...self.jsonSchema, description } };
    },
  };
}

// ── Composites ─────────────────────────────────────────────────────────────

export function optional<T>(inner: Schema<T>): OptionalSchema<T> {
  const s: Schema<T | undefined> = {
    "~standard": {
      version: 1,
      vendor: "dendra",
      validate(v) {
        return v === undefined
          ? ok(undefined)
          : (inner["~standard"].validate(v) as StandardResult<T | undefined>);
      },
    },
    jsonSchema: inner.jsonSchema,
    isOptional: true,
    describe(description) {
      return optional(inner.describe(description));
    },
  };
  return s as OptionalSchema<T>;
}

export interface ArraySchema<T> extends Schema<T[]> {
  min(length: number, message?: string): ArraySchema<T>;
  max(length: number, message?: string): ArraySchema<T>;
  describe(description: string): ArraySchema<T>;
}

function arraySchema<T>(
  inner: Schema<T>,
  jsonSchema: JSONSchema,
  checks: ReadonlyArray<Check<T[]>>,
): ArraySchema<T> {
  const self: Schema<T[]> = {
    "~standard": {
      version: 1,
      vendor: "dendra",
      async validate(v) {
        if (!Array.isArray(v)) {
          return fail(`Expected array, received ${received(v)}`);
        }
        for (const c of checks) {
          const m = c(v as T[]);
          if (m) return fail(m);
        }
        const out: T[] = [];
        for (let i = 0; i < v.length; i++) {
          const r = await inner["~standard"].validate(v[i]);
          if (isFailure(r)) {
            return {
              issues: r.issues.map((is) => ({
                message: is.message,
                path: [i, ...(is.path ?? [])],
              })),
            };
          }
          out.push((r as { value: T }).value);
        }
        return ok(out);
      },
    },
    jsonSchema,
    describe(description) {
      return arraySchema(inner, { ...jsonSchema, description }, checks);
    },
  };
  const next = (js: JSONSchema, c: Check<T[]>): ArraySchema<T> =>
    arraySchema(inner, js, [...checks, c]);
  return {
    ...self,
    min: (n, m) =>
      next({ ...jsonSchema, minItems: n }, (v) =>
        v.length >= n ? undefined : (m ?? `Must have at least ${n} items`),
      ),
    max: (n, m) =>
      next({ ...jsonSchema, maxItems: n }, (v) =>
        v.length <= n ? undefined : (m ?? `Must have at most ${n} items`),
      ),
    describe: (description) =>
      arraySchema(inner, { ...jsonSchema, description }, checks),
  };
}

export function array<T>(inner: Schema<T>): ArraySchema<T> {
  return arraySchema(inner, { type: "array", items: inner.jsonSchema }, []);
}

export function record<T>(value: Schema<T>): Schema<Record<string, T>> {
  return {
    "~standard": {
      version: 1,
      vendor: "dendra",
      async validate(v) {
        if (typeof v !== "object" || v === null || Array.isArray(v)) {
          return fail(`Expected object, received ${received(v)}`);
        }
        const rec = v as Record<string, unknown>;
        const out: Record<string, T> = {};
        const issues: StandardIssue[] = [];
        for (const k of Object.keys(rec)) {
          const r = await value["~standard"].validate(rec[k]);
          if (isFailure(r)) {
            for (const is of r.issues) {
              issues.push({ message: is.message, path: [k, ...(is.path ?? [])] });
            }
          } else {
            out[k] = (r as { value: T }).value;
          }
        }
        return issues.length ? { issues } : ok(out);
      },
    },
    jsonSchema: { type: "object", additionalProperties: value.jsonSchema },
    describe(description) {
      const self = record(value);
      return { ...self, jsonSchema: { ...self.jsonSchema, description } };
    },
  };
}

type RequiredKeys<Sh> = {
  [K in keyof Sh]: Sh[K] extends OptionalSchema<unknown> ? never : K;
}[keyof Sh];
type OptionalKeys<Sh> = {
  [K in keyof Sh]: Sh[K] extends OptionalSchema<unknown> ? K : never;
}[keyof Sh];
type Simplify<T> = { [K in keyof T]: T[K] } & {};
type ObjectOutput<Sh> = Simplify<
  { [K in RequiredKeys<Sh>]: OutputOf<Sh[K]> } & {
    [K in OptionalKeys<Sh>]?: OutputOf<Sh[K]>;
  }
>;

export interface ObjectSchema<T> extends Schema<T> {
  /** Reject unknown keys instead of silently stripping them. */
  strict(): ObjectSchema<T>;
  /** Keep unknown keys on the validated output. */
  passthrough(): ObjectSchema<T>;
  describe(description: string): ObjectSchema<T>;
}

function objectSchema<Sh extends Record<string, Schema<unknown>>>(
  shape: Sh,
  mode: UnknownKeyMode,
  description?: string,
): ObjectSchema<ObjectOutput<Sh>> {
  const properties: Record<string, JSONSchema> = {};
  const required: string[] = [];
  for (const k of Object.keys(shape)) {
    properties[k] = shape[k].jsonSchema;
    if (!shape[k].isOptional) required.push(k);
  }
  const jsonSchema: JSONSchema = { type: "object", properties, required };
  if (mode === "strict") jsonSchema.additionalProperties = false;
  if (mode === "passthrough") jsonSchema.additionalProperties = true;
  if (description) jsonSchema.description = description;

  const self: Schema<ObjectOutput<Sh>> = {
    "~standard": {
      version: 1,
      vendor: "dendra",
      async validate(v) {
        if (typeof v !== "object" || v === null || Array.isArray(v)) {
          return fail(`Expected object, received ${received(v)}`);
        }
        const rec = v as Record<string, unknown>;
        const value: Record<string, unknown> = {};
        const issues: StandardIssue[] = [];
        for (const k of Object.keys(shape)) {
          const r = await shape[k]["~standard"].validate(rec[k]);
          if (isFailure(r)) {
            for (const is of r.issues) {
              issues.push({ message: is.message, path: [k, ...(is.path ?? [])] });
            }
          } else if (r.value !== undefined) {
            value[k] = r.value;
          }
        }
        if (mode !== "strip") {
          for (const k of Object.keys(rec)) {
            if (k in shape) continue;
            if (mode === "strict") {
              issues.push({ message: `Unexpected key "${k}"`, path: [k] });
            } else {
              value[k] = rec[k]; // passthrough
            }
          }
        }
        if (issues.length) return { issues };
        return ok(value as ObjectOutput<Sh>);
      },
    },
    jsonSchema,
    describe(d) {
      return objectSchema(shape, mode, d);
    },
  };
  // Registered so chained `.input()` calls can merge two objects into one.
  return registerObjectShape(
    {
      ...self,
      strict: () => objectSchema(shape, "strict", description),
      passthrough: () => objectSchema(shape, "passthrough", description),
      describe: (d: string) => objectSchema(shape, mode, d),
    },
    { shape, mode, build: objectSchema },
  );
}

export function object<Sh extends Record<string, Schema<unknown>>>(
  shape: Sh,
): ObjectSchema<ObjectOutput<Sh>> {
  return objectSchema(shape, "strip");
}

// Reserved-word exports: `s.enum(...)` and `s.null()`.
export { enumSchema as enum, nullSchema as null };
export { fileSchema as file } from "./files.ts";
export type { FileSchema, FileSchemaOptions } from "./files.ts";
