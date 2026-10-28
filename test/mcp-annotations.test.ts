import { describe, it, expect } from "vitest";
import { initDendra, mcpToolDefinitions, inspectRouter, type RouterRecord } from "../src/index.ts";

// Per-tool MCP annotations from `.ai({ annotations })`, over the defaults dendra
// derives from `.get()` and `confirm` (#59).

const { route } = initDendra();
const router = {
  read: route.get().ai().handler(() => 1),
  publish: route.ai({ confirm: true }).handler(() => 1),
  plain: route.ai().handler(() => 1),
  // A POST that only reads (e.g. a search with a large body).
  search: route.ai({ annotations: { readOnlyHint: true, openWorldHint: false } }).handler(() => []),
  // A write that's safe to repeat and reaches outside the app.
  upsert: route
    .ai({ annotations: { idempotentHint: true, openWorldHint: true, destructiveHint: false, title: "Save a contact" } })
    .handler(() => 1),
  // A confirm tool that only adds, so not destructive.
  invite: route.ai({ confirm: true, annotations: { destructiveHint: false } }).handler(() => 1),
} satisfies RouterRecord;

const defs = Object.fromEntries(mcpToolDefinitions(router).map((d) => [d.name, d.annotations]));

describe("MCP tool annotations", () => {
  it("derives readOnly for .get() and destructive for confirm tools", () => {
    expect(defs.read).toEqual({ readOnlyHint: true });
    expect(defs.publish).toEqual({ readOnlyHint: false, destructiveHint: true });
    expect(defs.plain).toBeUndefined();
  });

  it("takes .ai({ annotations }) over the derived defaults", () => {
    expect(defs.search).toEqual({ readOnlyHint: true, openWorldHint: false });
    expect(defs.upsert).toEqual({
      title: "Save a contact",
      idempotentHint: true,
      openWorldHint: true,
      destructiveHint: false,
    });
    expect(defs.invite).toEqual({ readOnlyHint: false, destructiveHint: false });
  });

  it("shows the effective annotations in inspectRouter", () => {
    const info = Object.fromEntries(inspectRouter(router).map((r) => [r.path, r.annotations]));
    expect(info.read).toEqual({ readOnlyHint: true });
    expect(info.search).toEqual({ readOnlyHint: true, openWorldHint: false });
    expect(info.plain).toEqual({});
  });

  it("rejects a tool that is both read-only and destructive", () => {
    expect(() => route.ai({ annotations: { readOnlyHint: true, destructiveHint: true } })).toThrow(
      /readOnlyHint/,
    );
    expect(() => route.ai({ confirm: true, annotations: { readOnlyHint: true } }).handler(() => 1)).not.toThrow();
  });

  it("rejects .get() marked not read-only", () => {
    expect(() => route.get().ai({ annotations: { readOnlyHint: false } }).handler(() => 1)).toThrow(/get/);
  });
});
