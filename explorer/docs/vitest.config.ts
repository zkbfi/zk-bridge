import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { publicPagesPlugin } from "./public-pages.ts";
import { machineDocsPlugin } from "./machine/plugin.ts";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({
  plugins: [publicPagesPlugin({ repositoryRoot }), machineDocsPlugin({ repositoryRoot }), react()],
  resolve: {
    alias: {
      "@web": fileURLToPath(new URL("../web/src", import.meta.url)),
      // The faucet block uses the app's services and wallet, which import the terminal and the shared package (as in web/vitest.config.ts).
      "@terminal": fileURLToPath(new URL("../terminal/src", import.meta.url)),
      "@zk-bridge/shared/backend-client": fileURLToPath(new URL("../shared/src/backend-client.ts", import.meta.url)),
      "@zk-bridge/shared/msgboard-http": fileURLToPath(new URL("../shared/src/msgboard/board-http.ts", import.meta.url)),
      "@zk-bridge/shared": fileURLToPath(new URL("../shared/src/index.ts", import.meta.url)),
      "@zkb/react": fileURLToPath(new URL("../react/src/index.ts", import.meta.url)),
    },
  },
  server: { fs: { allow: [repositoryRoot] } },
  test: {
    maxWorkers: "25%",
    environment: "jsdom",
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    setupFiles: ["test/setup.ts"],
    css: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/**", "scripts/**", "machine/**", "public-pages.ts"],
      exclude: ["**/*.d.ts", "**/*.json"],
      thresholds: { lines: 100, branches: 100, functions: 100, statements: 100 },
    },
  },
});
