import { describe, it, expect } from "vitest";
import { initDendra, toOpenApiDocument, s, type RouterRecord } from "../src/index.ts";

const { route } = initDendra();

describe("file inputs and AI tools", () => {
  it("a procedure with file input can't be .ai(), whichever order", () => {
    expect(() =>
      route
        .input(s.object({ f: s.file() }))
        .ai()
        .handler(() => 1),
    ).toThrow(/file input.*can't be an AI tool/);
    expect(() =>
      route
        .ai()
        .input(s.object({ f: s.file() }))
        .stream(async function* () {}),
    ).toThrow(/file input.*can't be an AI tool/);
  });

  it("file input without .ai() is fine", () => {
    expect(() => route.input(s.object({ f: s.file() })).handler(() => 1)).not.toThrow();
  });
});

describe("OpenAPI", () => {
  const router = {
    covers: {
      upload: route
        .post("/covers")
        .input(s.object({ workspaceId: s.integer(), image: s.file() }))
        .handler(() => "ok"),
    },
    notes: {
      create: route
        .post("/notes")
        .input(s.object({ title: s.string() }))
        .handler(() => "ok"),
    },
  } satisfies RouterRecord;
  const doc = toOpenApiDocument(router, { info: { title: "t", version: "1" } }) as {
    paths: Record<string, Record<string, { requestBody?: { content: Record<string, { schema: { properties: Record<string, unknown> } }> } }>>;
  };

  it("documents file uploads as multipart/form-data", () => {
    const content = doc.paths["/covers"].post.requestBody!.content;
    expect(Object.keys(content)).toEqual(["multipart/form-data"]);
    const props = content["multipart/form-data"].schema.properties;
    expect(props.image).toEqual({ type: "string", format: "binary" });
    expect(props.workspaceId).toEqual({ type: "integer" });
  });

  it("leaves JSON procedures unchanged", () => {
    const content = doc.paths["/notes"].post.requestBody!.content;
    expect(Object.keys(content)).toEqual(["application/json"]);
    expect(content["application/json"].schema.properties.title).toEqual({ type: "string" });
  });
});
