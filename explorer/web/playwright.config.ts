import { defineConfig } from "@playwright/test";

/**
 * The smoke test runs against the sample data (`VITE_EXPLORER_DATA=fixture`), so it needs no network and no indexer.
 * It drives the installed Google Chrome, so no browser download is needed.
 */
export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  fullyParallel: false,
  reporter: "list",
  use: { baseURL: "http://localhost:5199", channel: "chrome", viewport: { width: 1280, height: 900 } },
  webServer: {
    command: "pnpm exec vite --port 5199 --strictPort",
    url: "http://localhost:5199",
    reuseExistingServer: true,
    timeout: 120_000,
    env: { VITE_EXPLORER_DATA: "fixture" },
  },
});
