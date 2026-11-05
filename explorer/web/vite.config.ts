import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { publicPagesPlugin } from "../docs/public-pages.ts";
import { refuseSecretsPlugin } from "./src/config/refuse-secrets-plugin.ts";

const terminalSource = fileURLToPath(new URL("../terminal/src", import.meta.url));
const sharedSource = fileURLToPath(new URL("../shared/src/index.ts", import.meta.url));
const backendClientSource = fileURLToPath(new URL("../shared/src/backend-client.ts", import.meta.url));
const msgboardHttpSource = fileURLToPath(new URL("../shared/src/msgboard/board-http.ts", import.meta.url));
const reactSource = fileURLToPath(new URL("../react/src/index.ts", import.meta.url));
const reactStyles = fileURLToPath(new URL("../react/styles.css", import.meta.url));
const explorerRoot = fileURLToPath(new URL("..", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({
  // The docs (explorer/docs) are part of this app, loaded lazily at #/docs. Only the help pages and the operator pages named
  // in explorer/docs/public-pages.json reach the build; any other docs/ import fails it.
  plugins: [publicPagesPlugin({ repositoryRoot }), react(), refuseSecretsPlugin()],
  // The two subpaths come first: an alias matches by prefix, and the plain name would swallow them.
  resolve: {
    alias: {
      "@terminal": terminalSource,
      "@web": fileURLToPath(new URL("./src", import.meta.url)),
      "@docs": fileURLToPath(new URL("../docs/src", import.meta.url)),
      "@zk-bridge/shared/backend-client": backendClientSource,
      "@zk-bridge/shared/msgboard-http": msgboardHttpSource,
      "@zk-bridge/shared": sharedSource,
      "@zkb/react/styles.css": reactStyles,
      "@zkb/react": reactSource,
    },
  },
  server: { fs: { allow: [explorerRoot] } },
  // Relative asset paths, so the build loads from any path prefix, such as an IPFS gateway path.
  base: "./",
  build: { target: "es2022", sourcemap: false },
});
