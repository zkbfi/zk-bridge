import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Share of the cores for this package. The four packages of `pnpm test` run at the same time, and the shares add
    // up to under 100 percent of the cores (web 50, bots 25, indexer 12, shared 12). Without a share, each run takes one
    // worker per core, and the Chakra tests of web miss their 1 second waits under the load.
    maxWorkers: "25%",
    include: ["test/unit/**/*.test.ts"],
    testTimeout: 60_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/**"],
      thresholds: { lines: 100, branches: 100, functions: 100, statements: 100 },
    },
  },
});
