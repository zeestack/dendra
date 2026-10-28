import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/anthropic.ts", "src/react.ts", "src/memory.ts", "src/next.ts", "src/adapter.ts"],
  format: ["esm", "cjs"],
  // Split CJS too (esbuild only splits ESM by default), so every subpath shares
  // one copy of core — otherwise `instanceof DendraError` fails across entries.
  splitting: true,
  dts: true,
  clean: true,
  sourcemap: true,
  target: "es2022",
  outDir: "dist",
});
