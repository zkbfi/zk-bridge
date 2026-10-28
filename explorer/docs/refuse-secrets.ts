import { loadEnv, type Plugin } from "vite";
import { findSecretLikeValues } from "../web/src/config/secret-scan.ts";

/**
 * Stops the build or the dev server when a `VITE_` variable looks like a key. It runs the same check as the dapp build
 * (`refuseSecretsPlugin` in `explorer/web/vite.config.ts`), through the same `findSecretLikeValues`. Vite copies every
 * `VITE_` variable into the page, so a key there would reach every visitor.
 *
 * @param settingsFolder The folder to read the settings files from. Default: the working folder.
 */
export const refuseSecretsPlugin = (settingsFolder: string = process.cwd()): Plugin => ({
  name: "zk-bridge-docs-refuse-secrets",
  config(_, { mode }) {
    const findings = findSecretLikeValues(loadEnv(mode, settingsFolder, "VITE_"));
    if (findings.length === 0) return;
    const lines = findings.map((finding) => `  ${finding.variable}: ${finding.reason}`).join("\n");
    throw new Error(`Refusing to build: a VITE_ variable looks like a secret, and the page would publish it.\n${lines}`);
  },
});
