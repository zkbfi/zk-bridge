import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    maxWorkers: "12%",
    environment: "node",
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/**", "scripts/**"],
      thresholds: { lines: 100, branches: 100, functions: 100, statements: 100 },
    },
  },
});
