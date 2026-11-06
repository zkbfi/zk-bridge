import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { publicPagesPlugin } from "../docs/public-pages.ts";
import { machineDocsPlugin } from "../docs/machine/plugin.ts";

export default defineConfig({
  plugins: [publicPagesPlugin({ repositoryRoot: fileURLToPath(new URL("../..", import.meta.url)) }), machineDocsPlugin({ repositoryRoot: fileURLToPath(new URL("../..", import.meta.url)) }), react()],
  resolve: {
    alias: {
      "@terminal": fileURLToPath(new URL("../terminal/src", import.meta.url)),
      "@web": fileURLToPath(new URL("./src", import.meta.url)),
      "@docs": fileURLToPath(new URL("../docs/src", import.meta.url)),
      // The two subpaths come first: an alias matches by prefix, and the plain name would swallow them.
      "@zk-bridge/shared/backend-client": fileURLToPath(new URL("../shared/src/backend-client.ts", import.meta.url)),
      "@zk-bridge/shared/msgboard-http": fileURLToPath(new URL("../shared/src/msgboard/board-http.ts", import.meta.url)),
      "@zk-bridge/shared": fileURLToPath(new URL("../shared/src/index.ts", import.meta.url)),
      "@zkb/react/styles.css": fileURLToPath(new URL("../react/styles.css", import.meta.url)),
      "@zkb/react": fileURLToPath(new URL("../react/src/index.ts", import.meta.url)),
    },
  },
  server: { fs: { allow: [fileURLToPath(new URL("..", import.meta.url))] } },
  test: {
    // Share of the cores for this package. The four packages of `pnpm test` run at the same time, and the shares add
    // up to under 100 percent of the cores (web 50, bots 25, indexer 12, shared 12). Without a share, each run takes one
    // worker per core, and the Chakra tests of web miss their 1 second waits under the load.
    maxWorkers: "50%",
    environment: "jsdom",
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    setupFiles: ["test/setup.ts"],
    css: false,
    // Chakra renders slowly in jsdom, and a busy machine slows it more.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**"],
      exclude: [
        // Thin entry: mounts the application and calls tested modules only.
        "src/main.tsx",
      ],
      thresholds: { lines: 100, branches: 100, functions: 100, statements: 100 },
    },
  },
});
