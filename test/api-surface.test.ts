import { describe, it, expect } from "vitest";
import * as dendra from "../src/index.ts";
import * as adapter from "../src/adapter.ts";
import * as memory from "../src/memory.ts";
import * as contextManager from "../src/context-manager.ts";
import { initDendra, toNextHandler } from "../src/index.ts";

// 0.12 moved some exports and kept the old names as deprecated aliases; 0.13
// removes the aliases (see the 1.0 upgrade guide).
describe("0.12 API moves, aliases removed in 0.13", () => {
  const core = dendra as Record<string, unknown>;

  it("serves the dispatch core from dendra/adapter only", () => {
    for (const name of ["resolveProc", "invokeUnary", "invokeStream"] as const) {
      expect(typeof adapter[name]).toBe("function");
      expect(core[name]).toBeUndefined();
    }
  });

  it("serves memory helpers from dendra/memory only", () => {
    for (const name of ["createMemoryStore", "recallMemory", "rememberFacts", "formatMemoryBlock"] as const) {
      expect(typeof memory[name]).toBe("function");
      expect(core[name]).toBeUndefined();
    }
  });

  it("has lazyToolSource, and no longer toolSource", () => {
    expect(dendra.lazyToolSource).toBe(contextManager.lazyToolSource);
    expect(core.toolSource).toBeUndefined();
  });

  it("toNextHandler returns only GET and POST", () => {
    const { route } = initDendra();
    expect(Object.keys(toNextHandler({ a: route.handler(() => 1) })).sort()).toEqual(["GET", "POST"]);
  });
});
