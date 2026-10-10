import { describe, it, expect } from "vitest";
import {
  initNexus,
  createCaller,
  toOpenApiDocument,
  s,
  type RouterRecord,
} from "../src/index.ts";

const { route } = initNexus();
const UserSchema = s.object({ id: s.string(), name: s.string() });

const router = {
  getUser: route
    .get("/users/:id")
    .input(s.object({ id: s.string() }))
    .output(UserSchema) // constrains the handler return AND documents the response
    .handler(({ input }) => ({ id: input.id, name: "Ada" })),
} satisfies RouterRecord;

describe(".output()", () => {
  it("runs the handler with output typed to the schema", async () => {
    const c = createCaller(router, {});
    expect(await c.getUser({ id: "1" })).toEqual({ id: "1", name: "Ada" });
  });

  it("puts the response schema in the OpenAPI document", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const doc = toOpenApiDocument(router, {
      info: { title: "t", version: "1" },
    }) as any;
    const schema =
      doc.paths["/users/{id}"].get.responses["200"].content["application/json"]
        .schema;
    expect(Object.keys(schema.properties)).toEqual(["id", "name"]);
  });
});
