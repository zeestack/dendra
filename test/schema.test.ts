import { describe, it, expect } from "vitest";
import { s } from "../src/index.ts";

describe("schema (Standard Schema validators)", () => {
  it("validates a valid object", async () => {
    const schema = s.object({ a: s.number(), b: s.string() });
    const r = await schema["~standard"].validate({ a: 1, b: "x" });
    expect(r).toEqual({ value: { a: 1, b: "x" } });
  });

  it("reports an issue with a path on bad input", async () => {
    const schema = s.object({ a: s.number(), b: s.string() });
    const r = await schema["~standard"].validate({ a: "nope", b: "x" });
    expect("issues" in r).toBe(true);
    if ("issues" in r && r.issues) {
      expect(r.issues[0]?.path).toEqual(["a"]);
    }
  });

  it("marks optional keys as not required in JSON Schema", () => {
    const schema = s.object({ a: s.number(), b: s.optional(s.string()) });
    expect(schema.jsonSchema.type).toBe("object");
    expect(schema.jsonSchema.required).toEqual(["a"]);
  });

  it("validates arrays element-wise", async () => {
    const schema = s.array(s.number());
    expect(await schema["~standard"].validate([1, 2, 3])).toEqual({
      value: [1, 2, 3],
    });
    const bad = await schema["~standard"].validate([1, "x"]);
    expect("issues" in bad).toBe(true);
  });
});
