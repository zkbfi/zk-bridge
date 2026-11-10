import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { PreflightResult } from "@zk-bridge/shared/msgboard";
import { REAL_SOURCE, health } from "../src/webhook/module.ts";
import { grindEngineHealth } from "../src/health.ts";
import { startBackend } from "../src/main.ts";
import { PAIR, SECRETS, makeBackend, makeConfig, memoryLogger } from "./support.ts";

const FAILED: PreflightResult = { ok: false, reason: "load-failed", detail: "no wasm" };
const ENVIRONMENT = { RUNPOD_API_KEY: SECRETS.runpodApiKey, BACKEND_WEBHOOK_BEARER: SECRETS.webhookBearer, PATH: "/usr/bin:/bin" };

function webhookConfig() {
  const directory = mkdtempSync(join(tmpdir(), "grind-engine-"));
  return makeConfig({ databasePath: join(directory, "backend.sqlite"), listen: { host: "127.0.0.1", port: 0 }, msgboardUrl: "http://board.invalid" });
}

describe("the grind engine at start-up", () => {
  it("turns a preflight result into the health of the engine", () => {
    expect(grindEngineHealth({ ok: true, durationMilliseconds: 12 })).toEqual({ state: "ok", durationMilliseconds: 12 });
    expect(grindEngineHealth(FAILED)).toEqual({ state: "failed", reason: "load-failed", detail: "no wasm" });
  });

  it("runs the preflight when the webhook runs, logs the failure, shows it on /health and degrades the webhook", async () => {
    const lines: string[] = [];
    const running = await startBackend({ config: webhookConfig(), pair: PAIR, enabled: ["webhook"], environment: ENVIRONMENT, write: (line) => lines.push(line), preflight: async () => FAILED });
    try {
      const report = (await (await fetch(`http://127.0.0.1:${running.port}/health`)).json()) as { grindEngine: unknown; modules: { webhook: { state: string; detail: string } } };
      expect(report.grindEngine).toEqual({ state: "failed", reason: "load-failed", detail: "no wasm" });
      expect(report.modules.webhook).toEqual({ state: "degraded", detail: "the proof-of-work engine failed its start-up test (load-failed: no wasm)" });
    } finally {
      await running.stop();
    }
    expect(lines.some((line) => line.includes('"grind_preflight_failed"') && line.includes('"reason":"load-failed"'))).toBe(true);
  });

  it("logs a pass and reports the engine ok", async () => {
    const lines: string[] = [];
    const running = await startBackend({ config: webhookConfig(), pair: PAIR, enabled: ["webhook"], environment: ENVIRONMENT, write: (line) => lines.push(line), preflight: async () => ({ ok: true, durationMilliseconds: 9 }) });
    try {
      const report = (await (await fetch(`http://127.0.0.1:${running.port}/health`)).json()) as { grindEngine: unknown };
      expect(report.grindEngine).toEqual({ state: "ok", durationMilliseconds: 9 });
    } finally {
      await running.stop();
    }
    expect(lines.some((line) => line.includes('"grind_preflight_passed"'))).toBe(true);
  });

  it("tests the real WASM engine on a worker thread by default", async () => {
    const running = await startBackend({ config: webhookConfig(), pair: PAIR, enabled: ["webhook"], environment: ENVIRONMENT, write: () => {} });
    try {
      const report = (await (await fetch(`http://127.0.0.1:${running.port}/health`)).json()) as { grindEngine: { state: string } };
      expect(report.grindEngine.state).toBe("ok");
    } finally {
      await running.stop();
    }
  });

  it("does not run the preflight when no module grinds, and /health has no engine field", async () => {
    const preflight = vi.fn(async () => FAILED);
    const running = await startBackend({ config: webhookConfig(), pair: PAIR, enabled: ["archive"], environment: ENVIRONMENT, write: () => {}, preflight });
    try {
      const report = (await (await fetch(`http://127.0.0.1:${running.port}/health`)).json()) as Record<string, unknown>;
      expect("grindEngine" in report).toBe(false);
    } finally {
      await running.stop();
    }
    expect(preflight).not.toHaveBeenCalled();
  });

  it("makes the real board refuse to grind, with the reason, after a failed preflight", async () => {
    const board = REAL_SOURCE.makeBoard("http://board.invalid", memoryLogger().logger, FAILED);
    await expect(board.post({ category: `0x${"11".repeat(32)}`, payload: "0xdeadbeef" })).rejects.toThrow(/failed its start-up test \(load-failed: no wasm\)/);
  });

  it("health of the webhook is running when the engine passed", () => {
    const backend = makeBackend({ enabled: ["webhook"], config: makeConfig({ msgboardUrl: "http://board.invalid" }), grindEngine: { ok: true, durationMilliseconds: 3 } });
    expect(health(backend.context).state).not.toBe("failed");
  });
});
