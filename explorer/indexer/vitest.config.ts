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
    // Share of the cores for this package. The four packages of `pnpm test` run at the same time, and the shares add
    // up to under 100 percent of the cores (web 50, bots 25, indexer 12, shared 12). Without a share, each run takes one
    // worker per core, and the Chakra tests of web miss their 1 second waits under the load.
    maxWorkers: "12%",
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
