// Minimal, zero-dependency validators that conform to the Standard Schema spec
// (https://standardschema.dev). Because they speak `~standard`, the framework
// can also accept Zod / Valibot / ArkType schemas interchangeably — nothing in
// core depends on this file. Each built-in schema additionally carries a
// `jsonSchema`, which is what powers OpenAPI generation and AI tool definitions.

export interface StandardIssue {
  readonly message: string;
  readonly path?: ReadonlyArray<PropertyKey>;
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
    readonly types?: { readonly input: Input; readonly output: Output };
  };
}

export type InferInput<S> =
  S extends StandardSchemaV1<infer I, unknown> ? I : never;
export type InferOutput<S> =
  S extends StandardSchemaV1<unknown, infer O> ? O : never;

export interface JSONSchema {
  type?: string;
  properties?: Record<string, JSONSchema>;
  required?: ReadonlyArray<string>;
  items?: JSONSchema;
  description?: string;
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

function make<T>(
  validate: (v: unknown) => StandardResult<T> | Promise<StandardResult<T>>,
  jsonSchema: JSONSchema,
  isOptional = false,
): Schema<T> {
  return {
    "~standard": { version: 1, vendor: "dendra", validate },
    jsonSchema,
    isOptional,
    describe(description: string) {
      return make<T>(validate, { ...jsonSchema, description }, isOptional);
    },
  };
}

export function string(): Schema<string> {
  return make<string>(
    (v) => (typeof v === "string" ? ok(v) : fail("Expected string")),
    { type: "string" },
  );
}

export function number(): Schema<number> {
  return make<number>(
    (v) =>
      typeof v === "number" && !Number.isNaN(v)
        ? ok(v)
        : fail("Expected number"),
    { type: "number" },
  );
}

export function boolean(): Schema<boolean> {
  return make<boolean>(
    (v) => (typeof v === "boolean" ? ok(v) : fail("Expected boolean")),
    { type: "boolean" },
  );
}

export function optional<T>(inner: Schema<T>): OptionalSchema<T> {
  const s = make<T | undefined>(
    (v) =>
      v === undefined
        ? ok(undefined)
        : (inner["~standard"].validate(v) as StandardResult<T | undefined>),
    inner.jsonSchema,
    true,
  );
  return s as OptionalSchema<T>;
}

export function array<T>(inner: Schema<T>): Schema<T[]> {
  return make<T[]>(
    async (v) => {
      if (!Array.isArray(v)) return fail("Expected array");
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
    { type: "array", items: inner.jsonSchema },
  );
}

type OutputOf<S> = S extends Schema<infer T> ? T : never;
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

export function object<Sh extends Record<string, Schema<unknown>>>(
  shape: Sh,
): Schema<ObjectOutput<Sh>> {
  const properties: Record<string, JSONSchema> = {};
  const required: string[] = [];
  for (const k of Object.keys(shape)) {
    properties[k] = shape[k].jsonSchema;
    if (!shape[k].isOptional) required.push(k);
  }
  return make<ObjectOutput<Sh>>(
    async (v) => {
      if (typeof v !== "object" || v === null || Array.isArray(v)) {
        return fail("Expected object");
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
      if (issues.length) return { issues };
      return ok(value as ObjectOutput<Sh>);
    },
    { type: "object", properties, required },
  );
}
