import { defineConfig } from "vitest/config";

// The package config includes test/unit only. Run the red team tests from explorer/bots with:
// pnpm vitest run --config test/redteam/vitest.redteam.config.ts
export default defineConfig({ test: { root: new URL("../..", import.meta.url).pathname, include: ["test/redteam/**/*.test.ts"], testTimeout: 60_000 } });
