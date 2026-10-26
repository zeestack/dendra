import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  // Forks, not threads: the test chdirs into a temp dir for its SQLite file.
  test: { include: ["test/**/*.test.ts"], pool: "forks" },
});
