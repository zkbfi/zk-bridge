import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { BackendConfigError, endpointSecrets, endpointValues, loadBackendPair, parseBackendConfig, readSecrets } from "../src/config.ts";
import { main, parseArguments, startBackend } from "../src/main.ts";
import { PAIR, READ_SECRETS, SECRETS, makeConfig } from "./support.ts";

const ENVIRONMENT = { RUNPOD_API_KEY: SECRETS.runpodApiKey, BACKEND_WEBHOOK_BEARER: SECRETS.webhookBearer, PATH: "/usr/bin" };
const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

const indexers: Array<{ close: () => void }> = [];
afterEach(() => indexers.splice(0).forEach((server) => server.close()));

/** A chain indexer on a free local port where a message of every direction waits for a head. */
async function needyIndexer(): Promise<string> {
  const app = new Hono();
  app.get("/api/feed", (c) => c.json({ items: [{}], nextCursor: null }));
  app.get("/api/heads", (c) => c.json({ heads: [] }));
  const port = await new Promise<number>((resolve) => {
    indexers.push(serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, (address) => resolve(address.port)));
  });
  return `http://127.0.0.1:${port}`;
}

/** An indexer address for a backend that starts no job in the test. */
const INDEXER_URL = "http://indexer.invalid";

function workspace(): string {
  const directory = mkdtempSync(join(tmpdir(), "backend-main-"));
  directories.push(directory);
  return directory;
}

describe("configuration", () => {
  it("applies the defaults: 10 requests a minute, 60 seconds after a failure, a $5 GPU budget, the forwarded header off", () => {
    const config = makeConfig();
    expect(config.limits).toEqual({
      requestsPerCallerPerMinute: 10,
      requestsPerUnknownCallerPerMinute: 2,
      globalRequestsPerMinute: 120,
      requestRetentionHours: 24,
      secondsBeforeRetryAfterFailure: 60,
      gpuBudgetUsdPerDirectionPerDay: 5,
      keepAliveSeconds: 43_200,
      pendingProofStaleSeconds: 600,
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
    expect(config.remote.endpoints?.map((endpoint) => endpoint.apiKeyVariable)).toEqual([undefined, "RUNPOD_API_KEY"]);
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
    expect(readSecrets(config, ENVIRONMENT)).toEqual(READ_SECRETS);
    expect(() => readSecrets(config, { ...ENVIRONMENT, RUNPOD_API_KEY: undefined })).toThrow("set the environment variable RUNPOD_API_KEY");
    expect(() => readSecrets(config, { ...ENVIRONMENT, BACKEND_WEBHOOK_BEARER: "" })).toThrow("set the environment variable BACKEND_WEBHOOK_BEARER");
  });
});

const section = (chainId: number, digit: string) => {
  const address = `0x${digit.repeat(40)}`;
  return { chain_id: chainId, bridge: address, mediator: address, token_factory: address, wrapped_native: address, gate: address, light_client: address, start_block: 1 };
};
const DEPLOYMENT = { chain_a: section(1, "1"), chain_b: section(369, "2") };
const KEYED_RPC = "http://rpc-1.invalid/rpc/SECRETKEY123/evm/1";
const KEYED_BOARD = "wss://board.invalid/KEYBOARD456";

describe("endpoints in the configuration", () => {
  const endpoints = {
    rpcUrls: { "1": "http://rpc-1.invalid", "369": "http://rpc-369.invalid" },
    beaconUrls: { "1": "http://beacon-1.invalid" },
  };

  it("builds the pair from the deployment file and the configuration, with no environment variable", () => {
    vi.stubEnv("EXPLORER_RPC_URL_1", "http://wrong.invalid");
    try {
      const pair = loadBackendPair(makeConfig(endpoints), DEPLOYMENT);
      expect(pair.sides.map((side) => side.rpcUrl)).toEqual(["http://rpc-1.invalid", "http://rpc-369.invalid"]);
      expect(pair.sides.map((side) => side.beaconUrl)).toEqual(["http://beacon-1.invalid", null]);
      expect(pair.sides[1].contracts.lightClient).toBe(`0x${"2".repeat(40)}`);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("passes the state URLs of a chain to the pair, and lists them as addresses that can carry a key", () => {
    const keyed = "https://states-1.invalid/beacon/KEYSTATES777/1";
    const config = makeConfig({ ...endpoints, stateUrls: { "1": [keyed] } });
    const pair = loadBackendPair(config, DEPLOYMENT);
    expect(pair.sides[0].stateUrls).toEqual([keyed]);
    expect(pair.sides[1].stateUrls).toEqual([]);
    expect(endpointValues(config, pair)).toContain(keyed);
    expect(() => makeConfig({ stateUrls: { "1": ["not a url"] } })).toThrow(BackendConfigError);
  });

  it("passes the header RPCs of a chain to the pair, and lists them as addresses that can carry a key", () => {
    const keyed = "https://header-1.invalid/v1/KEYHEADER777";
    const config = makeConfig({ ...endpoints, headerRpcUrls: { "1": [keyed] } });
    const pair = loadBackendPair(config, DEPLOYMENT);
    expect(pair.sides[0].headerRpcUrls).toEqual([keyed]);
    expect(pair.sides[1].headerRpcUrls).toEqual([]);
    expect(endpointValues(config, pair)).toContain(keyed);
    expect(() => makeConfig({ headerRpcUrls: { "1": ["not a url"] } })).toThrow(BackendConfigError);
  });

  it("passes the handoff URLs of a chain to the pair, and lists them and the archive URLs as addresses that can carry a key", () => {
    const keyed = "https://handoff-1.invalid/v1/KEYHANDOFF777";
    const archive = "https://archive.invalid/KEYARCHIVE888/handoff-updates";
    const config = makeConfig({ ...endpoints, handoffUrls: { "1": [keyed] }, handoffArchiveUrls: [archive] });
    const pair = loadBackendPair(config, DEPLOYMENT);
    expect(pair.sides[0].handoffUrls).toEqual([keyed]);
    expect(pair.sides[1].handoffUrls).toBeUndefined();
    expect(endpointValues(config, pair)).toEqual(expect.arrayContaining([keyed, archive]));
    expect(() => makeConfig({ handoffUrls: { "1": ["ws://x.invalid"] } })).toThrow(BackendConfigError);
  });

  it("names the missing chain, or the unknown pair", () => {
    expect(() => loadBackendPair(makeConfig({ rpcUrls: { "1": "http://rpc-1.invalid" } }), DEPLOYMENT)).toThrow("rpcUrls needs an entry for chain 369");
    expect(() => loadBackendPair(makeConfig({ ...endpoints, pair: "nowhere" }), DEPLOYMENT)).toThrow('unknown pair "nowhere"');
  });

  it("refuses an address that is not a URL, and a msgboard address with the wrong scheme", () => {
    expect(() => makeConfig({ rpcUrls: { "1": "not a url" } })).toThrow(BackendConfigError);
    expect(() => makeConfig({ rpcUrls: { one: "http://rpc.invalid" } })).toThrow(BackendConfigError);
    expect(() => makeConfig({ msgboardUrl: "ftp://board.invalid" })).toThrow(/ws, wss, http or https/);
    expect(makeConfig({ msgboardUrl: "wss://board.invalid" }).msgboardUrl).toBe("wss://board.invalid");
  });

  it("lists every address that can carry a key", () => {
    const config = makeConfig({ ...endpoints, msgboardUrl: KEYED_BOARD, indexerUrl: "http://indexer.invalid" });
    const values = endpointValues(config, PAIR);
    expect(values).toEqual(expect.arrayContaining([KEYED_BOARD, "http://rpc-1.invalid", "http://beacon-1.invalid", "https://endpoint.example.org", "http://indexer.invalid", PAIR.sides[0].rpcUrl]));
    expect(endpointValues(makeConfig(), null)).toEqual(["https://endpoint.example.org"]);
    const withoutBeacon = { ...PAIR, sides: [{ ...PAIR.sides[0], beaconUrl: null }, PAIR.sides[1]] } as typeof PAIR;
    expect(endpointValues(makeConfig(), withoutBeacon)).not.toContain("");
  });

  it("lists the secret parts of each address, a long path segment alone, and no plain word", () => {
    const secrets = endpointSecrets(makeConfig({ rpcUrls: { "1": KEYED_RPC }, msgboardUrl: KEYED_BOARD }), null);
    expect(secrets).toEqual(expect.arrayContaining([KEYED_RPC, "rpc/SECRETKEY123/evm/1", "SECRETKEY123", KEYED_BOARD, "KEYBOARD456"]));
    expect(secrets).not.toContain("rpc");
    expect(secrets).not.toContain("evm");
  });
});

describe("secrets in the log", () => {
  const configFor = (directory: string, indexerUrl = INDEXER_URL) =>
    makeConfig({
      databasePath: join(directory, "backend.sqlite"),
      listen: { host: "127.0.0.1", port: 0 },
      rpcUrls: { "1": KEYED_RPC, "369": "http://rpc-369.invalid" },
      beaconUrls: { "1": "http://beacon-1.invalid", "369": "http://beacon-369.invalid" },
      msgboardUrl: KEYED_BOARD,
      indexerUrl,
    });

  it("a keyed endpoint inside an error is removed from the log line", async () => {
    const lines: string[] = [];
    const executor = async () => {
      throw new Error(`cannot reach ${KEYED_RPC} or ${KEYED_BOARD}; the key is SECRETKEY123 and KEYBOARD456`);
    };
    const running = await startBackend({ config: configFor(workspace(), await needyIndexer()), pair: PAIR, enabled: ["requests"], environment: ENVIRONMENT, executor, write: (line) => lines.push(line) });
    try {
      const answer = await fetch(`http://127.0.0.1:${running.port}/requests`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pair: "eth-pls", direction: "first-to-second", reason: "user" }),
      });
      expect(answer.status).toBe(202);
      await vi.waitFor(() => expect(lines.some((line) => line.includes("job_failed"))).toBe(true));
    } finally {
      await running.stop();
    }
    const text = lines.join("\n");
    expect(text).toContain("cannot reach");
    expect(text).not.toContain("SECRETKEY123");
    expect(text).not.toContain("KEYBOARD456");
    expect(text).not.toContain(SECRETS.webhookBearer);
  });

  it("reads RunPod's billing for a RunPod endpoint with a key, serves it on /warmup/summary, and logs no key", async () => {
    const real = globalThis.fetch;
    const seen: string[] = [];
    const runpod = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (!url.includes("runpod.")) return real(input, init);
      seen.push(`${url} ${new Headers(init?.headers).get("authorization")}`);
      if (url.includes("/v1/endpoints/")) {
        if ((init?.method ?? "GET") === "PATCH") return Response.json({ idleTimeout: 5 });
        return Response.json({ idleTimeout: 60, workersMin: 0, workersMax: 1 });
      }
      if (url.includes("graphql")) return Response.json({ data: { myself: { clientBalance: 153.38, currentSpendPerHr: 0, spendLimit: 80 } } });
      const today = new Date().toISOString().slice(0, 10);
      return Response.json([{ time: `${today} 00:00:00`, amount: 0.76, timeBilledMs: 3_600_000 }]);
    };
    vi.stubGlobal("fetch", runpod);
    const lines: string[] = [];
    const config = makeConfig({ ...configFor(workspace(), await needyIndexer()), remote: { endpoint: "https://abc123.api.runpod.ai" } });
    const running = await startBackend({ config, pair: PAIR, enabled: ["requests"], environment: ENVIRONMENT, write: (line) => lines.push(line) });
    try {
      const body = (await (await real(`http://127.0.0.1:${running.port}/warmup/summary`)).json()) as { rateSource: string; usdPerHour: number; billing: { balanceUsd: number } };
      expect(body).toMatchObject({ rateSource: "runpod", usdPerHour: 0.76, billing: { balanceUsd: 153.38 } });
    } finally {
      await running.stop();
      vi.unstubAllGlobals();
    }
    // The day and hour billing and the balance, and at start-up the endpoint's idle timeout: read, then set from 60 to 5.
    expect(seen.length).toBe(5);
    expect(seen.filter((entry) => entry.includes("/v1/endpoints/abc123 "))).toHaveLength(2);
    expect(seen.every((entry) => entry.endsWith(`Bearer ${SECRETS.runpodApiKey}`))).toBe(true);
    expect(lines.join("\n")).toContain('"runpod_idle_timeout_set"');
    expect(lines.join("\n")).toContain('"from":60,"to":5');
    // The endpoint's timeout, as read and as set, went into the history that the billing breakdown reads.
    const history = new DatabaseSync(config.databasePath);
    try {
      const rows = history.prepare("SELECT seconds FROM idle_timeout_history ORDER BY at").all() as Array<{ seconds: number }>;
      expect(rows.map((row) => row.seconds).slice(0, 2)).toEqual([60, 5]);
      expect(rows.length).toBeGreaterThanOrEqual(3);
      expect(rows[rows.length - 1]?.seconds).toBe(5);
    } finally {
      history.close();
    }
    expect(lines.join("\n")).not.toContain(SECRETS.runpodApiKey);
  });

  it("starts, serves both idle timeouts on /billing, and keeps the key out of the log when RunPod cannot be reached for the idle timeout", async () => {
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (!url.includes("runpod.")) return real(input, init);
      throw new TypeError(`fetch failed for ${url}`);
    });
    const lines: string[] = [];
    const config = makeConfig({ ...configFor(workspace(), await needyIndexer()), remote: { endpoint: "https://abc123.api.runpod.ai" } });
    const running = await startBackend({ config, pair: PAIR, enabled: ["requests"], environment: ENVIRONMENT, write: (line) => lines.push(line) });
    try {
      const body = (await (await real(`http://127.0.0.1:${running.port}/billing`)).json()) as { assumptions: { idleTimeoutSeconds: number; endpointIdleTimeoutSeconds: number | null } };
      expect(body.assumptions).toMatchObject({ idleTimeoutSeconds: 5, endpointIdleTimeoutSeconds: null });
    } finally {
      await running.stop();
      vi.unstubAllGlobals();
    }
    expect(lines.join("\n")).toContain('"runpod_idle_timeout_failed"');
    expect(lines.join("\n")).not.toContain(SECRETS.runpodApiKey);
  });

  it("the requests module needs a beacon endpoint for both chains", async () => {
    const lonely = { ...PAIR, sides: [PAIR.sides[0], { ...PAIR.sides[1], beaconUrl: null }] } as typeof PAIR;
    await expect(startBackend({ config: configFor(workspace()), pair: lonely, enabled: ["requests"], environment: ENVIRONMENT, write: () => {} })).rejects.toThrow("beaconUrls needs an entry for chain 369");
  });

  it("the requests module needs the chain indexer", async () => {
    const config = makeConfig({ ...configFor(workspace()), indexerUrl: undefined });
    await expect(startBackend({ config, pair: PAIR, enabled: ["requests"], environment: ENVIRONMENT, write: () => {} })).rejects.toThrow("indexerUrl is needed when the requests module runs");
  });

  it("main hides a configured endpoint in a start-up error and survives an unset secret variable", async () => {
    const directory = workspace();
    const configFile = join(directory, "backend.json");
    writeFileSync(
      configFile,
      JSON.stringify({
        schemaVersion: 1,
        deploymentFile: join(directory, "deployment.json"),
        databasePath: join(directory, "backend.sqlite"),
        publicUrl: "https://backend.example.org",
        prover: { binary: "/bin/zk-bridge-prover" },
        remote: { endpoint: "https://endpoint.example.org" },
        runpodApiKeyVariable: "RUNPOD_API_KEY",
        webhookBearerVariable: "BACKEND_WEBHOOK_BEARER",
        msgboardUrl: KEYED_BOARD,
      }),
    );
    writeFileSync(join(directory, "deployment.json"), JSON.stringify(DEPLOYMENT));
    const lines: string[] = [];
    // Neither secret variable is set, and the pair has no rpcUrls: the run stops early with a plain message.
    expect(await main(["--config", configFile], { PATH: "/usr/bin" }, { write: (line) => lines.push(line) })).toBe(1);
    expect(lines[0]).toContain("rpcUrls needs an entry for chain 1");
    expect(lines[0]).not.toContain("KEYBOARD456");
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
    const config = makeConfig({ databasePath: join(directory, "data", "backend.sqlite"), listen: { host: "127.0.0.1", port: 0 }, indexerUrl: INDEXER_URL });
    const lines: string[] = [];
    const running = await startBackend({ config, pair: PAIR, enabled: ["requests", "archive"], environment: ENVIRONMENT, write: (line) => lines.push(line), now: () => 0 });
    try {
      const answer = await fetch(`http://127.0.0.1:${running.port}/health`);
      const report = (await answer.json()) as { modules: Record<string, { state: string }> };
      expect(Object.keys(report.modules)).toEqual(["requests", "archive"]);
      expect(report.modules.requests).toEqual({ state: "running" });
      const unseen = await fetch(`http://127.0.0.1:${running.port}/webhook/jobs/x`, { method: "POST" });
      expect(unseen.status).toBe(404);
    } finally {
      await running.stop();
    }
    expect(lines.join("\n")).toContain("backend_started");
    expect(lines.join("\n")).not.toContain(SECRETS.runpodApiKey);
    expect(lines.join("\n")).not.toContain(SECRETS.webhookBearer);
  });

  it("runs without the chain indexer when the requests module is off", async () => {
    const directory = workspace();
    const config = makeConfig({ databasePath: join(directory, "backend.sqlite"), listen: { host: "127.0.0.1", port: 0 } });
    const running = await startBackend({ config, pair: PAIR, enabled: ["archive"], environment: ENVIRONMENT, write: () => {} });
    try {
      const report = (await (await fetch(`http://127.0.0.1:${running.port}/health`)).json()) as { modules: Record<string, unknown> };
      expect(report.modules).toEqual({ archive: { state: "degraded", detail: "indexerUrl is not set; 0 handoff records, 0 periods failing" } });
    } finally {
      await running.stop();
    }
  });

  it("writes to standard error and the real clock by default", async () => {
    const directory = workspace();
    const config = makeConfig({ databasePath: join(directory, "backend.sqlite"), listen: { host: "127.0.0.1", port: 0 }, indexerUrl: INDEXER_URL });
    const running = await startBackend({ config, pair: PAIR, enabled: ["requests"], environment: ENVIRONMENT });
    await running.stop();
  });

  it("fails fast when a secret variable is not set", async () => {
    await expect(startBackend({ config: makeConfig(), pair: PAIR, enabled: ["requests"], environment: { PATH: "/usr/bin" } })).rejects.toThrow(BackendConfigError);
  });

  it("falls back to a default PATH", async () => {
    const directory = workspace();
    const config = makeConfig({ databasePath: join(directory, "backend.sqlite"), listen: { host: "127.0.0.1", port: 0 }, indexerUrl: INDEXER_URL });
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
        rpcUrls: { "1": "http://rpc-1.invalid", "369": "http://rpc-369.invalid" },
        beaconUrls: { "1": "http://beacon-1.invalid", "369": "http://beacon-369.invalid" },
        indexerUrl: INDEXER_URL,
      }),
    );
    const environment = ENVIRONMENT;
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
        rpcUrls: { "1": "http://rpc-1.invalid", "369": "http://rpc-369.invalid" },
        beaconUrls: { "1": "http://beacon-1.invalid", "369": "http://beacon-369.invalid" },
        indexerUrl: INDEXER_URL,
      }),
    );
    const environment = ENVIRONMENT;
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
