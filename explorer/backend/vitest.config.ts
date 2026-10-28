import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // A small share of the cores: the packages of `pnpm test` run at the same time.
    maxWorkers: "12%",
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/**"],
      thresholds: { lines: 100, branches: 100, functions: 100, statements: 100 },
    },
  },
});
