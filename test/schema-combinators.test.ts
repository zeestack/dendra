import { describe, it, expect } from "vitest";
import { s } from "../src/index.ts";
import type { Schema } from "../src/index.ts";

// Small helpers to read Standard Schema results.
async function val<T>(schema: Schema<T>, v: unknown) {
  return schema["~standard"].validate(v);
}
async function value<T>(schema: Schema<T>, v: unknown): Promise<T> {
  const r = await val(schema, v);
  if ("issues" in r && r.issues) throw new Error(r.issues[0]?.message);
  return (r as { value: T }).value;
}
async function issues<T>(schema: Schema<T>, v: unknown) {
  const r = await val(schema, v);
  if (!("issues" in r) || !r.issues) throw new Error("expected issues");
  return r.issues;
}

describe("literal / enum / union / null / nullable", () => {
  it("literal matches only the exact value", async () => {
    const lit = s.literal("open");
    expect(await value(lit, "open")).toBe("open");
    expect(await issues(lit, "closed")).toHaveLength(1);
    expect(lit.jsonSchema.const).toBe("open");
  });

  it("enum accepts members and emits an enum schema", async () => {
    const status = s.enum(["open", "closed", "archived"] as const);
    expect(await value(status, "closed")).toBe("closed");
    expect(await issues(status, "nope")).toHaveLength(1);
    expect(status.jsonSchema.enum).toEqual(["open", "closed", "archived"]);
  });

  it("union accepts any variant", async () => {
    const u = s.union([s.string(), s.number()]);
    expect(await value(u, "x")).toBe("x");
    expect(await value(u, 7)).toBe(7);
    expect(await issues(u, true)).toHaveLength(1);
    expect(u.jsonSchema.anyOf).toHaveLength(2);
  });

  it("null and nullable", async () => {
    expect(await value(s.null(), null)).toBe(null);
    const nn = s.nullable(s.string());
    expect(await value(nn, null)).toBe(null);
    expect(await value(nn, "hi")).toBe("hi");
    expect(await issues(nn, 5)).toHaveLength(1);
  });
});

describe("string constraints", () => {
  it("min / max / length", async () => {
    const title = s.string().min(1).max(5);
    expect(await value(title, "abc")).toBe("abc");
    expect(await issues(title, "")).toHaveLength(1);
    expect(await issues(title, "toolong")).toHaveLength(1);
    expect(title.jsonSchema.minLength).toBe(1);
    expect(title.jsonSchema.maxLength).toBe(5);
  });

  it("pattern, email, uuid, url with formats", async () => {
    expect(await value(s.string().email(), "a@b.co")).toBe("a@b.co");
    expect(await issues(s.string().email(), "nope")).toHaveLength(1);
    expect(s.string().email().jsonSchema.format).toBe("email");

    const id = s.string().uuid();
    expect(
      await value(id, "123e4567-e89b-12d3-a456-426614174000"),
    ).toBeTypeOf("string");
    expect(await issues(id, "not-a-uuid")).toHaveLength(1);

    expect(await value(s.string().url(), "https://x.dev")).toBe("https://x.dev");
    expect(await issues(s.string().url(), "x.dev")).toHaveLength(1);

    const code = s.string().pattern(/^[A-Z]{3}$/);
    expect(await value(code, "ABC")).toBe("ABC");
    expect(await issues(code, "ab")).toHaveLength(1);
    expect(code.jsonSchema.pattern).toBe("^[A-Z]{3}$");
  });

  it("custom messages are used", async () => {
    const title = s.string().min(3, "Too short");
    expect((await issues(title, "a"))[0]?.message).toBe("Too short");
  });
});

describe("number / integer constraints", () => {
  it("min / max / int", async () => {
    const age = s.number().min(0).max(120);
    expect(await value(age, 30)).toBe(30);
    expect(await issues(age, -1)).toHaveLength(1);
    expect(await issues(age, 200)).toHaveLength(1);
    expect(age.jsonSchema.minimum).toBe(0);
    expect(age.jsonSchema.maximum).toBe(120);

    const qty = s.integer().min(1);
    expect(await value(qty, 3)).toBe(3);
    expect(await issues(qty, 1.5)).toHaveLength(1);
    expect(qty.jsonSchema.type).toBe("integer");
  });
});

describe("array constraints", () => {
  it("min / max items", async () => {
    const tags = s.array(s.string()).min(1).max(3);
    expect(await value(tags, ["a"])).toEqual(["a"]);
    expect(await issues(tags, [])).toHaveLength(1);
    expect(await issues(tags, ["a", "b", "c", "d"])).toHaveLength(1);
    expect(tags.jsonSchema.minItems).toBe(1);
    expect(tags.jsonSchema.maxItems).toBe(3);
  });
});

describe("record", () => {
  it("validates string-keyed maps", async () => {
    const scores = s.record(s.number());
    expect(await value(scores, { a: 1, b: 2 })).toEqual({ a: 1, b: 2 });
    expect(await issues(scores, { a: "x" })).toHaveLength(1);
    expect(scores.jsonSchema.additionalProperties).toEqual({ type: "number" });
  });
});

describe("object strict / passthrough", () => {
  it("strip (default) drops unknown keys", async () => {
    const o = s.object({ a: s.number() });
    expect(await value(o, { a: 1, extra: 9 })).toEqual({ a: 1 });
  });

  it("strict rejects unknown keys", async () => {
    const o = s.object({ a: s.number() }).strict();
    const iss = await issues(o, { a: 1, extra: 9 });
    expect(iss[0]?.path).toEqual(["extra"]);
    expect(o.jsonSchema.additionalProperties).toBe(false);
  });

  it("passthrough keeps unknown keys", async () => {
    const o = s.object({ a: s.number() }).passthrough();
    expect(await value(o, { a: 1, extra: 9 })).toEqual({ a: 1, extra: 9 });
    expect(o.jsonSchema.additionalProperties).toBe(true);
  });
});

describe("error messages include the received type", () => {
  it("names the wrong type", async () => {
    expect((await issues(s.string(), 5))[0]?.message).toBe(
      "Expected string, received number",
    );
    expect((await issues(s.number(), "x"))[0]?.message).toBe(
      "Expected number, received string",
    );
    expect((await issues(s.object({ a: s.number() }), []))[0]?.message).toBe(
      "Expected object, received array",
    );
  });
});

describe("nested composition flows into JSON Schema", () => {
  it("enum + constraints inside an object", () => {
    const schema = s.object({
      status: s.enum(["open", "closed"] as const),
      title: s.string().min(1).max(200),
      priority: s.optional(s.integer().min(1).max(5)),
    });
    const props = schema.jsonSchema.properties!;
    expect(props.status.enum).toEqual(["open", "closed"]);
    expect(props.title.maxLength).toBe(200);
    expect(schema.jsonSchema.required).toEqual(["status", "title"]);
  });
});
