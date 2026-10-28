import { describe, it, expect } from "vitest";
import { z } from "zod";
import { z as z3 } from "zod/v3";
import * as v from "valibot";
import { toStandardJsonSchema } from "@valibot/to-json-schema";
import { type } from "arktype";
import {
  initDendra,
  toToolset,
  toOpenApiDocument,
  s,
  type PlainTool,
  type RouterRecord,
} from "../src/index.ts";

// Third-party schemas publish JSON Schema through Standard JSON Schema
// (`~standard.jsonSchema`), so they show up in tools and OpenAPI like `s.*` (#65).

const { route } = initDendra();

const toolSchema = (router: RouterRecord, name: string) =>
  (toToolset(router, { format: "plain" }) as PlainTool[]).find((t) => t.name === name)!.inputSchema;

describe("JSON Schema from third-party libraries", () => {
  const router = {
    zod: route.ai().input(z.object({ a: z.number().min(1), b: z.string().optional() })).handler(() => 1),
    ark: route.ai().input(type({ a: "number>0", "b?": "string" })).handler(() => 1),
    valibot: route
      .ai()
      .input(toStandardJsonSchema(v.object({ a: v.pipe(v.number(), v.minValue(1)), b: v.optional(v.string()) })))
      .handler(() => 1),
  } satisfies RouterRecord;

  for (const name of ["zod", "ark", "valibot"] as const) {
    it(`${name}: the tool gets the schema, constraints included`, () => {
      const schema = toolSchema(router, name);
      expect(schema).toMatchObject({ type: "object", required: ["a"] });
      expect(Object.keys(schema.properties ?? {}).sort()).toEqual(["a", "b"]);
      expect(schema.properties!.a).toMatchObject({ type: "number" });
      expect(JSON.stringify(schema.properties!.a)).toMatch(/inimum/);
    });
  }

  it("drops $schema, which belongs on a document, not an embedded schema", () => {
    expect(toolSchema(router, "zod")).not.toHaveProperty("$schema");
  });

  it("OpenAPI documents a Zod request body and response", () => {
    const api = {
      create: route
        .post("/notes")
        .input(z.object({ title: z.string().min(1) }))
        .output(z.object({ id: z.number() }))
        .handler(() => ({ id: 1 })),
      list: route.get("/notes").input(z.object({ q: z.string() })).handler(() => []),
    } satisfies RouterRecord;
    const doc = toOpenApiDocument(api, { info: { title: "t", version: "1" } }) as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
    };
    const post = doc.paths["/notes"].post as {
      requestBody: { content: Record<string, { schema: unknown }> };
      responses: Record<string, { content: Record<string, { schema: unknown }> }>;
    };
    expect(post.requestBody.content["application/json"].schema).toMatchObject({
      properties: { title: { type: "string", minLength: 1 } },
    });
    expect(JSON.stringify(post.responses)).toContain('"id"');
    const get = doc.paths["/notes"].get as { parameters: Array<{ name: string }> };
    expect(get.parameters.map((p) => p.name)).toEqual(["q"]);
  });

  it("chains a Zod input onto an s.object, publishing both", () => {
    const r = {
      both: route
        .ai()
        .input(s.object({ workspaceId: s.integer() }))
        .input(z.object({ title: z.string() }))
        .handler(() => 1),
    } satisfies RouterRecord;
    expect(Object.keys(toolSchema(r, "both").properties ?? {}).sort()).toEqual(["title", "workspaceId"]);
  });
});

describe(".ai() needs a JSON Schema for its input", () => {
  it("throws where it's defined for a schema that publishes none (Zod 3, plain Valibot)", () => {
    expect(() => route.ai().input(z3.object({ a: z3.number() })).handler(() => 1)).toThrow(
      /JSON Schema.*zod/s,
    );
    expect(() => route.input(v.object({ a: v.number() })).ai().handler(() => 1)).toThrow(
      /toStandardJsonSchema/,
    );
  });

  it("throws with the library's reason when it can't convert", () => {
    expect(() => route.ai().input(z.object({ at: z.date() })).handler(() => 1)).toThrow(/Date/);
  });

  it("throws when one part of a chained input publishes none", () => {
    expect(() =>
      route
        .ai()
        .input(s.object({ workspaceId: s.integer() }))
        .input(z3.object({ a: z3.number() }))
        .handler(() => 1),
    ).toThrow(/JSON Schema/);
  });

  it("is fine without .ai(), and for .ai() with no input", () => {
    expect(() => route.input(z3.object({ a: z3.number() })).handler(() => 1)).not.toThrow();
    expect(() => route.input(z.object({ at: z.date() })).handler(() => 1)).not.toThrow();
    expect(() => route.ai().handler(() => 1)).not.toThrow();
  });
});
