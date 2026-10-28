import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { refuseSecretsPlugin } from "./refuse-secrets.ts";

const webSource = fileURLToPath(new URL("../web/src", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({
  plugins: [react(), refuseSecretsPlugin()],
  resolve: { alias: { "@web": webSource } },
  // The pages read Markdown from `docs/` at the repository root.
  server: { fs: { allow: [repositoryRoot] } },
  // Relative asset paths, so the build loads from any path prefix, such as an IPFS gateway path.
  base: "./",
  build: { target: "es2022", sourcemap: false },
});
