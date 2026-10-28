import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";

// The deprecation policy (website/content/versioning.mdx): every @deprecated tag
// names the release that removes it, and nothing outlives that release.
const src = new URL("../src/", import.meta.url);
const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

const tags = readdirSync(src)
  .filter((f) => f.endsWith(".ts"))
  .flatMap((file) =>
    readFileSync(new URL(file, src), "utf8")
      // A tag can wrap onto the next JSDoc lines; take it up to the comment's end.
      .split("@deprecated")
      .slice(1)
      .map((rest) => ({ file, text: rest.slice(0, rest.indexOf("*/")).replace(/\s*\*\s*/g, " ") })),
  );

const minor = (v: string) => v.split(".").slice(0, 2).map(Number);
const reached = (v: string) => {
  const [a, b] = minor(version);
  const [x, y] = minor(v);
  return a > x || (a === x && b >= y);
};

describe("deprecations", () => {
  it("finds the tags it checks", () => {
    expect(tags.length).toBeGreaterThan(0);
  });

  it("every @deprecated names its removal release", () => {
    const missing = tags.filter((t) => !/Removed in \d+\.\d+\./.test(t.text));
    expect(missing).toEqual([]);
  });

  it(`nothing deprecated survives its removal release (package is ${version})`, () => {
    const overdue = tags.filter((t) => reached(t.text.match(/Removed in (\d+\.\d+)\./)?.[1] ?? "999.0"));
    expect(overdue).toEqual([]);
  });
});
