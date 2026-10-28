import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BackendConfigError, parseBackendConfig, readSecrets } from "../src/config.ts";
import { main, parseArguments, startBackend } from "../src/main.ts";
import { PAIR, SECRETS, makeConfig } from "./support.ts";

const ENVIRONMENT = { RUNPOD_API_KEY: SECRETS.runpodApiKey, BACKEND_WEBHOOK_BEARER: SECRETS.webhookBearer, PATH: "/usr/bin" };
const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

function workspace(): string {
  const directory = mkdtempSync(join(tmpdir(), "backend-main-"));
  directories.push(directory);
  return directory;
}

describe("configuration", () => {
  it("applies the defaults of the brief: 10 requests a minute, 120 seconds, 60 seconds, the forwarded header off", () => {
    const config = makeConfig();
    expect(config.limits).toEqual({
      requestsPerCallerPerMinute: 10,
      requestsPerUnknownCallerPerMinute: 2,
      globalRequestsPerMinute: 120,
      requestRetentionHours: 24,
      secondsBetweenJobsPerDirection: 120,
      secondsBeforeRetryAfterFailure: 60,
    });
    expect(config.trustedProxyHops).toBe(1);
    expect(config.trustForwardedHeader).toBe(false);
    expect(config.modules).toEqual(["requests"]);
    expect(config.pair).toBe("eth-pls");
  });

  it("refuses a retention window shorter than the prover timeout", () => {
    expect(() => makeConfig({ prover: { binary: "/bin/p", timeoutSeconds: 7200 }, limits: { requestRetentionHours: 1 } })).toThrow(/requestRetentionHours/);
    expect(makeConfig({ prover: { binary: "/bin/p", timeoutSeconds: 3600 }, limits: { requestRetentionHours: 1 } }).limits.requestRetentionHours).toBe(1);
  });

  it("the example file is valid and holds only variable names", () => {
    const text = readFileSync(new URL("../backend.config.example.json", import.meta.url), "utf8");
    const config = parseBackendConfig(text);
    expect(config.runpodApiKeyVariable).toBe("RUNPOD_API_KEY");
    expect(config.webhookBearerVariable).toBe("BACKEND_WEBHOOK_BEARER");
    expect(config.modules).toEqual(["requests", "webhook", "msgboard-indexer", "archive"]);
  });

  it("refuses text that is not JSON, an unknown key, and a variable name with a bad shape", () => {
    expect(() => parseBackendConfig("{")).toThrow(BackendConfigError);
    expect(() => parseBackendConfig(JSON.stringify({ schemaVersion: 1, extra: true }))).toThrow(/not valid/);
    expect(() => makeConfig({ runpodApiKeyVariable: "op://vault/item" })).toThrow(/environment variable/);
    expect(() => parseBackendConfig("[]")).toThrow(/\(file\)|not valid/);
  });

  it("refuses a webhook bearer value shorter than 32 bytes, names the variable, and never shows the value", () => {
    const config = makeConfig();
    const short = "short-value-of-31-bytes-aaaaaaa";
    expect(Buffer.byteLength(short)).toBe(31);
    let message = "";
    try {
      readSecrets(config, { ...ENVIRONMENT, BACKEND_WEBHOOK_BEARER: short });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("BACKEND_WEBHOOK_BEARER");
    expect(message).toContain("32 bytes");
    expect(message).not.toContain(short);
    expect(readSecrets(config, { ...ENVIRONMENT, BACKEND_WEBHOOK_BEARER: "a".repeat(32) }).webhookBearer).toHaveLength(32);
  });

  it("reads the two secrets from the environment and names the missing variable", () => {
    const config = makeConfig();
    expect(readSecrets(config, ENVIRONMENT)).toEqual(SECRETS);
    expect(() => readSecrets(config, { ...ENVIRONMENT, RUNPOD_API_KEY: undefined })).toThrow("set the environment variable RUNPOD_API_KEY");
    expect(() => readSecrets(config, { ...ENVIRONMENT, BACKEND_WEBHOOK_BEARER: "" })).toThrow("set the environment variable BACKEND_WEBHOOK_BEARER");
  });
});

describe("command line", () => {
  it("reads --config and --modules", () => {
    expect(parseArguments(["--config", "a.json"])).toEqual({ configPath: "a.json", modules: null });
    expect(parseArguments(["--config", "a.json", "--modules", "requests,archive"])).toEqual({ configPath: "a.json", modules: ["requests", "archive"] });
  });

  it("refuses a missing file, an unknown module, an unknown flag and a flag with no value", () => {
    expect(() => parseArguments([])).toThrow(/--config/);
    expect(() => parseArguments(["--config", "a", "--modules", "requests,nope"])).toThrow(/unknown module "nope"/);
    expect(() => parseArguments(["--bogus", "x"])).toThrow(/unknown argument --bogus/);
    expect(() => parseArguments(["--config"])).toThrow(/needs a value/);
  });
});

describe("startBackend", () => {
  it("serves the health report over a real socket, with the chosen modules only, and stops cleanly", async () => {
    const directory = workspace();
    const config = makeConfig({ databasePath: join(directory, "data", "backend.sqlite"), listen: { host: "127.0.0.1", port: 0 } });
    const lines: string[] = [];
    const running = await startBackend({ config, pair: PAIR, enabled: ["requests", "archive"], environment: ENVIRONMENT, write: (line) => lines.push(line), now: () => 0 });
    try {
      const answer = await fetch(`http://127.0.0.1:${running.port}/health`);
      const report = (await answer.json()) as { modules: Record<string, { state: string }> };
      expect(report.modules).toEqual({ requests: { state: "running" }, archive: { state: "degraded", detail: "indexerUrl is not set" } });
      const unseen = await fetch(`http://127.0.0.1:${running.port}/webhook/jobs/x`, { method: "POST" });
      expect(unseen.status).toBe(404);
    } finally {
      await running.stop();
    }
    expect(lines.join("\n")).toContain("backend_started");
    expect(lines.join("\n")).not.toContain(SECRETS.runpodApiKey);
    expect(lines.join("\n")).not.toContain(SECRETS.webhookBearer);
  });

  it("writes to standard error and the real clock by default", async () => {
    const directory = workspace();
    const config = makeConfig({ databasePath: join(directory, "backend.sqlite"), listen: { host: "127.0.0.1", port: 0 } });
    const running = await startBackend({ config, pair: PAIR, enabled: ["requests"], environment: ENVIRONMENT });
    await running.stop();
  });

  it("fails fast when a secret variable is not set", async () => {
    await expect(startBackend({ config: makeConfig(), pair: PAIR, enabled: ["requests"], environment: { PATH: "/usr/bin" } })).rejects.toThrow(BackendConfigError);
  });

  it("falls back to a default PATH", async () => {
    const directory = workspace();
    const config = makeConfig({ databasePath: join(directory, "backend.sqlite"), listen: { host: "127.0.0.1", port: 0 } });
    const { PATH: _ignored, ...environment } = ENVIRONMENT;
    const running = await startBackend({ config, pair: PAIR, enabled: ["requests"], environment, write: () => {} });
    await running.stop();
  });
});

describe("main", () => {
  function deploymentSection(chainId: number, digit: string) {
    const address = `0x${digit.repeat(40)}`;
    return { chain_id: chainId, bridge: address, mediator: address, token_factory: address, wrapped_native: address, gate: address, light_client: address, start_block: 1 };
  }

  it("runs until the stop signal, then returns 0", async () => {
    const directory = workspace();
    const deploymentFile = join(directory, "deployment.json");
    writeFileSync(deploymentFile, JSON.stringify({ chain_a: deploymentSection(1, "1"), chain_b: deploymentSection(369, "2") }));
    const configFile = join(directory, "backend.json");
    writeFileSync(
      configFile,
      JSON.stringify({
        schemaVersion: 1,
        deploymentFile,
        databasePath: join(directory, "backend.sqlite"),
        listen: { host: "127.0.0.1", port: 0 },
        publicUrl: "https://backend.example.org",
        prover: { binary: "/bin/zk-bridge-prover" },
        remote: { endpoint: "https://endpoint.example.org" },
        runpodApiKeyVariable: "RUNPOD_API_KEY",
        webhookBearerVariable: "BACKEND_WEBHOOK_BEARER",
      }),
    );
    const environment = { ...ENVIRONMENT, EXPLORER_RPC_URL_1: "http://rpc-1.invalid", EXPLORER_RPC_URL_369: "http://rpc-369.invalid" };
    const early = new AbortController();
    early.abort();
    expect(await main(["--config", configFile], environment, { stopSignal: early.signal, write: () => {} })).toBe(0);

    const later = new AbortController();
    const finished = main(["--config", configFile, "--modules", "requests"], environment, { stopSignal: later.signal, write: () => {} });
    await new Promise((resolve) => setTimeout(resolve, 100));
    later.abort();
    expect(await finished).toBe(0);
  });

  it("listens for the process signals when no stop signal is given", async () => {
    const directory = workspace();
    const deploymentFile = join(directory, "deployment.json");
    writeFileSync(deploymentFile, JSON.stringify({ chain_a: deploymentSection(1, "1"), chain_b: deploymentSection(369, "2") }));
    const configFile = join(directory, "backend.json");
    writeFileSync(
      configFile,
      JSON.stringify({
        schemaVersion: 1,
        deploymentFile,
        databasePath: join(directory, "backend.sqlite"),
        listen: { host: "127.0.0.1", port: 0 },
        publicUrl: "https://backend.example.org",
        prover: { binary: "/bin/zk-bridge-prover" },
        remote: { endpoint: "https://endpoint.example.org" },
        runpodApiKeyVariable: "RUNPOD_API_KEY",
        webhookBearerVariable: "BACKEND_WEBHOOK_BEARER",
      }),
    );
    const environment = { ...ENVIRONMENT, EXPLORER_RPC_URL_1: "http://rpc-1.invalid", EXPLORER_RPC_URL_369: "http://rpc-369.invalid" };
    const finished = main(["--config", configFile], environment, { write: () => {} });
    await new Promise((resolve) => setTimeout(resolve, 200));
    process.emit("SIGTERM");
    expect(await finished).toBe(0);
    const again = main(["--config", configFile], environment, { write: () => {} });
    await new Promise((resolve) => setTimeout(resolve, 200));
    process.emit("SIGINT");
    expect(await again).toBe(0);
  });

  it("writes a configuration error to standard error by default", async () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(await main([], ENVIRONMENT)).toBe(1);
      expect(String(spy.mock.calls[0]?.[0])).toContain("zk-bridge-backend: name the configuration file");
    } finally {
      spy.mockRestore();
    }
  });

  it("removes a configured value from the start-up error", async () => {
    const directory = workspace();
    const configFile = join(directory, "backend.json");
    writeFileSync(
      configFile,
      JSON.stringify({
        schemaVersion: 1,
        deploymentFile: join(directory, `missing-${SECRETS.webhookBearer}.json`),
        databasePath: join(directory, "backend.sqlite"),
        publicUrl: "https://backend.example.org",
        prover: { binary: "/bin/zk-bridge-prover" },
        remote: { endpoint: "https://endpoint.example.org" },
        runpodApiKeyVariable: "RUNPOD_API_KEY",
        webhookBearerVariable: "BACKEND_WEBHOOK_BEARER",
      }),
    );
    const lines: string[] = [];
    const environment = { ...ENVIRONMENT, EXPLORER_RPC_URL_1: "" };
    expect(await main(["--config", configFile], environment, { write: (line) => lines.push(line) })).toBe(1);
    expect(lines[0]).toContain("ENOENT");
    expect(lines[0]).not.toContain(SECRETS.webhookBearer);
  });

  it("returns 1 and says why when the configuration is wrong", async () => {
    const lines: string[] = [];
    expect(await main([], ENVIRONMENT, { write: (line) => lines.push(line) })).toBe(1);
    expect(lines[0]).toContain("--config");
  });
});
