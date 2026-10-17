import { describe, it, expect } from "vitest";
import { s } from "../src/index.ts";
import { sniffType } from "../src/files.ts";

const bytes = (...parts: Array<number[] | string>) =>
  new Uint8Array(
    parts.flatMap((p) => (typeof p === "string" ? [...new TextEncoder().encode(p)] : p)),
  );
const PNG = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "rest-of-png");
const JPEG = bytes([0xff, 0xd8, 0xff, 0xe0], "jfif");
const WEBP = bytes("RIFF", [1, 2, 3, 4], "WEBPVP8 ");
const PDF = bytes("%PDF-1.7\n");

const image = s.file({ types: ["image/png", "image/jpeg", "image/webp"] });
const validate = (schema: { "~standard": { validate: (v: unknown) => unknown } }, v: unknown) =>
  schema["~standard"].validate(v) as Promise<{
    value?: File;
    issues?: Array<{ message: string }>;
  }>;

describe("sniffType", () => {
  it("recognises the built-in signatures", () => {
    expect(sniffType(PNG)).toBe("image/png");
    expect(sniffType(JPEG)).toBe("image/jpeg");
    expect(sniffType(WEBP)).toBe("image/webp");
    expect(sniffType(PDF)).toBe("application/pdf");
    expect(sniffType(bytes("GIF89a"))).toBe("image/gif");
    expect(sniffType(bytes([0x50, 0x4b, 0x03, 0x04]))).toBe("application/zip");
    expect(sniffType(bytes("hello"))).toBeUndefined();
    expect(sniffType(new Uint8Array())).toBeUndefined();
  });
});

describe("s.file()", () => {
  it("accepts a correctly labelled image and returns a File", async () => {
    const r = await validate(image, new File([PNG], "a.png", { type: "image/png" }));
    expect(r.issues).toBeUndefined();
    expect(r.value).toBeInstanceOf(File);
    expect(r.value!.name).toBe("a.png");
  });

  it("rejects a PDF labelled as a PNG, naming what the bytes are", async () => {
    const r = await validate(image, new File([PDF], "a.png", { type: "image/png" }));
    expect(r.issues![0].message).toContain("got bytes of application/pdf");
  });

  it("rejects PNG bytes labelled as JPEG (bytes must match the declared type)", async () => {
    const r = await validate(image, new File([PNG], "a.jpg", { type: "image/jpeg" }));
    expect(r.issues).toBeDefined();
  });

  it("matches types without a signature by MIME type or extension", async () => {
    const csv = s.file({ types: ["text/csv", ".csv"] });
    const excel = await validate(
      csv,
      new File(["a,b\n1,2"], "report.CSV", { type: "application/vnd.ms-excel" }),
    );
    expect(excel.issues).toBeUndefined();
    const txt = await validate(csv, new File(["x"], "report.txt", { type: "text/plain" }));
    expect(txt.issues).toBeDefined();
  });

  it("enforces maxBytes", async () => {
    const r = await validate(s.file({ maxBytes: 10 }), new File(["12345678901"], "a.txt"));
    expect(r.issues![0].message).toContain("10");
  });

  it("wraps a bare Blob into a File named 'blob'", async () => {
    const r = await validate(s.file(), new Blob(["hi"], { type: "text/plain" }));
    expect(r.value).toBeInstanceOf(File);
    expect(r.value!.name).toBe("blob");
    expect(r.value!.type).toBe("text/plain");
  });

  it("rejects non-files", async () => {
    const r = await validate(s.file(), "not a file");
    expect(r.issues![0].message).toContain("expected a file");
  });

  it("handles empty and tiny files without throwing", async () => {
    const empty = await validate(image, new File([], "a.png", { type: "image/png" }));
    expect(empty.issues).toBeDefined();
    const tiny = await validate(
      s.file({ types: ["text/plain"] }),
      new File(["abc"], "a.txt", { type: "text/plain" }),
    );
    expect(tiny.issues).toBeUndefined();
  });

  it("validates inside s.object", async () => {
    const schema = s.object({ workspaceId: s.integer(), image });
    const ok = await validate(schema, {
      workspaceId: 3,
      image: new File([PNG], "a.png", { type: "image/png" }),
    });
    expect(ok.issues).toBeUndefined();
    const bad = await validate(schema, {
      workspaceId: 3,
      image: new File([PDF], "a.png", { type: "image/png" }),
    });
    expect(bad.issues).toBeDefined();
  });

  it("emits a binary JSON Schema with the dendra file marker", () => {
    expect(s.object({ f: s.file() }).jsonSchema.properties!.f).toEqual({
      type: "string",
      format: "binary",
      "x-dendra-file": true,
    });
    expect(s.file({ types: ["image/png"], maxBytes: 5 }).jsonSchema).toEqual({
      type: "string",
      format: "binary",
      "x-dendra-file": true,
      contentMediaType: "image/png",
      maxLength: 5,
    });
    expect(s.file().describe("A cover").jsonSchema.description).toBe("A cover");
  });
});
