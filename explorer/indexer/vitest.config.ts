import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const path = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

export default defineConfig({
  resolve: {
    // Ponder serves these modules at run time. The unit tests serve the real schema and fakes of the other two.
    alias: {
      "ponder:schema": path("./ponder.schema.ts"),
      "ponder:registry": path("./test/unit/support/fake-registry.ts"),
      "ponder:api": path("./test/unit/support/fake-api.ts"),
    },
  },
  test: {
    include: ["test/unit/**/*.test.ts"],
    setupFiles: ["./test/unit/support/pair-variables.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/**"],
      thresholds: { lines: 100, branches: 100, functions: 100, statements: 100 },
    },
  },
});
