import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { refuseSecretsPlugin } from "../web/src/config/refuse-secrets-plugin.ts";
import { publicPagesPlugin } from "./public-pages.ts";

const webSource = fileURLToPath(new URL("../web/src", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({
  // Only the help pages and the operator pages named in public-pages.json are published; any other docs/ import fails the build.
  plugins: [publicPagesPlugin({ repositoryRoot }), react(), refuseSecretsPlugin()],
  resolve: { alias: { "@web": webSource } },
  // The help pages are read from explorer/web/docs and the styles from explorer/web/src.
  server: { fs: { allow: [repositoryRoot] } },
  // Relative asset paths, so the build loads from any path prefix, such as an IPFS gateway path.
  base: "./",
  build: { target: "es2022", sourcemap: false },
});
