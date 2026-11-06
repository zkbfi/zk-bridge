import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { publicPagesPlugin } from "./public-pages.ts";
import { machineDocsPlugin } from "./machine/plugin.ts";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({
  plugins: [publicPagesPlugin({ repositoryRoot }), machineDocsPlugin({ repositoryRoot }), react()],
  resolve: { alias: { "@web": fileURLToPath(new URL("../web/src", import.meta.url)) } },
  server: { fs: { allow: [repositoryRoot] } },
  test: {
    maxWorkers: "25%",
    environment: "jsdom",
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    setupFiles: ["test/setup.ts"],
    css: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
