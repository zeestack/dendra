import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/anthropic.ts", "src/react.ts", "src/memory.ts", "src/next.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "es2022",
  outDir: "dist",
});
