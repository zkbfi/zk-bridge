import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Share of the cores for this package, so it does not starve the other packages of `pnpm test`.
    maxWorkers: "12%",
    include: ["test/**/*.test.ts"],
    // The command-line tests pack whole directories, which is slow under load.
    testTimeout: 60_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/**"],
      exclude: [
        // Thin process entry: it only passes argv and the standard streams to run(), which main.test.ts covers.
        "src/cli.ts",
      ],
      thresholds: { lines: 100, branches: 100, functions: 100, statements: 100 },
    },
  },
});
