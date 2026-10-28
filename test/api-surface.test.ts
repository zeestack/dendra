import { describe, it, expect } from "vitest";
import * as dendra from "../src/index.ts";
import * as adapter from "../src/adapter.ts";
import * as memory from "../src/memory.ts";
import * as contextManager from "../src/context-manager.ts";
import { initDendra, toNextHandler } from "../src/index.ts";

// 0.12 moved some exports; the old names stay as deprecated aliases until 0.13.
describe("0.12 API moves", () => {
  it("serves the dispatch core from dendra/adapter, with aliases in core", () => {
    for (const name of ["resolveProc", "invokeUnary", "invokeStream"] as const) {
      expect(typeof adapter[name]).toBe("function");
      expect(dendra[name]).toBe(adapter[name]);
    }
  });

  it("serves memory helpers from dendra/memory, with aliases in core", () => {
    for (const name of ["createMemoryStore", "recallMemory", "rememberFacts", "formatMemoryBlock"] as const) {
      expect(dendra[name]).toBe(memory[name]);
    }
  });

  it("renames toolSource to lazyToolSource, keeping the old name", () => {
    expect(dendra.lazyToolSource).toBe(contextManager.lazyToolSource);
    expect(dendra.toolSource).toBe(dendra.lazyToolSource);
  });

  it("toNextHandler returns only GET and POST", () => {
    const { route } = initDendra();
    expect(Object.keys(toNextHandler({ a: route.handler(() => 1) })).sort()).toEqual(["GET", "POST"]);
  });
});
