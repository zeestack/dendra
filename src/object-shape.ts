// Internal: the shape behind each built-in `s.object(...)`, so chained
// `.input()` calls can merge two of them into one object schema. Kept out of
// schema.ts because everything exported there becomes public under `s.*`, and
// core must not depend on schema.ts — so the builder travels with the shape.

import type { Schema } from "./schema.ts";

export type UnknownKeyMode = "strip" | "strict" | "passthrough";

export interface ObjectShape {
  shape: Record<string, Schema<unknown>>;
  mode: UnknownKeyMode;
  build: (shape: Record<string, Schema<unknown>>, mode: UnknownKeyMode) => Schema<unknown>;
}

const shapes = new WeakMap<object, ObjectShape>();

export function registerObjectShape<T extends object>(schema: T, info: ObjectShape): T {
  shapes.set(schema, info);
  return schema;
}

export function objectShapeOf(schema: unknown): ObjectShape | undefined {
  return typeof schema === "object" && schema !== null ? shapes.get(schema) : undefined;
}
