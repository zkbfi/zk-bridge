import { loadEnv, type Plugin } from "vite";
import { findSecretLikeValues } from "./secret-scan.ts";

/**
 * Stops the build or the dev server when a `VITE_` variable looks like a key. Vite copies every `VITE_` variable into
 * the page, so a key there would reach every visitor. Every Vite build of the project uses this one plugin.
 *
 * @param settingsFolder The folder to read the settings files from. Default: the working folder.
 */
export const refuseSecretsPlugin = (settingsFolder: string = process.cwd()): Plugin => ({
  name: "zk-bridge-refuse-secrets",
  config(_, { mode }) {
    const findings = findSecretLikeValues(loadEnv(mode, settingsFolder, "VITE_"));
    if (findings.length === 0) return;
    const lines = findings.map((finding) => `  ${finding.variable}: ${finding.reason}`).join("\n");
    throw new Error(`Refusing to build: a VITE_ variable looks like a secret, and the page would publish it.\n${lines}`);
  },
});
