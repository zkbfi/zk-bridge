import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type Plugin } from "vite";
import { findSecretLikeValues } from "./src/config/secret-scan.ts";

const terminalSource = fileURLToPath(new URL("../terminal/src", import.meta.url));
const sharedSource = fileURLToPath(new URL("../shared/src/index.ts", import.meta.url));
const explorerRoot = fileURLToPath(new URL("..", import.meta.url));

/**
 * Stops the build or the dev server when a `VITE_` variable looks like a key. Vite copies every `VITE_` variable into
 * the page, so a key there would reach every visitor.
 */
const refuseSecretsPlugin = (): Plugin => ({
  name: "zk-bridge-refuse-secrets",
  config(_, { mode }) {
    const environment = loadEnv(mode, process.cwd(), "VITE_");
    const findings = findSecretLikeValues(environment);
    if (findings.length === 0) return;
    const lines = findings.map((finding) => `  ${finding.variable}: ${finding.reason}`).join("\n");
    throw new Error(`Refusing to build: a VITE_ variable looks like a secret, and the page would publish it.\n${lines}`);
  },
});

export default defineConfig({
  plugins: [react(), refuseSecretsPlugin()],
  resolve: { alias: { "@terminal": terminalSource, "@zk-bridge/shared": sharedSource } },
  server: { fs: { allow: [explorerRoot] } },
  // Relative asset paths, so the build loads from any path prefix, such as an IPFS gateway path.
  base: "./",
  build: { target: "es2022", sourcemap: false },
});
