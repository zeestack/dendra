import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import ts from "typescript";

// The API reference (website/content/reference) covers the whole public API:
// every export of every entry point, every route builder method and every `s.*`
// validator is defined there, and nothing is defined that no longer exists.
//
// A name is defined by a heading that opens with it in backticks: ### `name(…)`.
// Builder methods are written `.name(…)`, validators `s.name(…)`.

const root = new URL("../", import.meta.url);
const entries = ["index", "next", "react", "anthropic", "memory", "adapter"];

const program = ts.createProgram(
  entries.map((e) => new URL(`src/${e}.ts`, root).pathname),
  { allowImportingTsExtensions: true, noEmit: true, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, target: ts.ScriptTarget.ES2022, skipLibCheck: true },
);
const checker = program.getTypeChecker();
const moduleExports = (file: string) => {
  const sf = program.getSourceFile(new URL(`src/${file}.ts`, root).pathname)!;
  return checker.getExportsOfModule(checker.getSymbolAtLocation(sf)!);
};

const exported = new Set<string>();
for (const e of entries) for (const sym of moduleExports(e)) if (sym.name !== "s") exported.add(sym.name);

const validators = moduleExports("schema")
  .filter((sym) => checker.getTypeOfSymbol(sym).getCallSignatures().length > 0)
  .map((sym) => `s.${sym.name}`);

const core = program.getSourceFile(new URL("src/core.ts", root).pathname)!;
const builder = core.statements.find(
  (n): n is ts.ClassDeclaration => ts.isClassDeclaration(n) && n.name?.text === "Builder",
)!;
const builderMethods = [
  ...new Set(
    builder.members
      .filter(ts.isMethodDeclaration)
      .filter((m) => !m.modifiers?.some((mod) => mod.kind === ts.SyntaxKind.PrivateKeyword))
      .map((m) => `.${(m.name as ts.Identifier).text}`),
  ),
];

const refDir = new URL("website/content/reference/", root);
const pages = readdirSync(refDir).filter((f) => f.endsWith(".mdx"));
const defined = new Map<string, string>();
const duplicates: string[] = [];
for (const page of pages) {
  const text = readFileSync(new URL(page, refDir), "utf8");
  for (const m of text.matchAll(/^#{2,4} `([.\w]+)[^`]*`/gm)) {
    if (defined.has(m[1])) duplicates.push(`${m[1]} (${defined.get(m[1])}, ${page})`);
    else defined.set(m[1], page);
  }
}

describe("API reference", () => {
  it("finds what it checks", () => {
    expect(exported.size).toBeGreaterThan(100);
    expect(validators).toContain("s.object");
    expect(builderMethods).toContain(".input");
    expect(pages.length).toBeGreaterThan(0);
  });

  it("defines every export of every entry point", () => {
    expect([...exported].filter((name) => !defined.has(name))).toEqual([]);
  });

  it("defines every route builder method", () => {
    expect(builderMethods.filter((name) => !defined.has(name))).toEqual([]);
  });

  it("defines every s.* validator", () => {
    expect(validators.filter((name) => !defined.has(name))).toEqual([]);
  });

  it("defines nothing that isn't exported", () => {
    const known = new Set([...exported, ...validators, ...builderMethods]);
    expect([...defined.keys()].filter((name) => !known.has(name))).toEqual([]);
  });

  it("defines each name once", () => {
    expect(duplicates).toEqual([]);
  });
});
