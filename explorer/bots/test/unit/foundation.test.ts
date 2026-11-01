import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { BotConfigError, parseBotConfig, runnerMinimumPriorityFeeWei } from "../../src/config/bot-config.ts";
import { parseCommandLine } from "../../src/cli.ts";
import { createLogger } from "../../src/logging/logger.ts";
import { createSecretVault, openSecretStore } from "../../src/runtime/secrets.ts";
import { runLoop } from "../../src/runtime/loop.ts";
import { StateFileError, createStateFile } from "../../src/runtime/state-file.ts";
import { createFileOutcomeSink } from "../../src/runner/outcomes.ts";
import { createSerialQueue } from "../../src/runner/serial-queue.ts";
import { memoryLogger } from "../support/builders.ts";

// Made-up values with the real shapes. None is a live key.
const RUNPOD_KEY = "rpa_TESTONLY1234567890abcdefghijkl";
const VALVE_KEY = "vk_TESTONLY0987654321zyxwvu";

const scratch: string[] = [];
afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function scratchDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "bots-foundation-"));
  scratch.push(directory);
  return directory;
}

describe("the logger", () => {
  it("writes one JSON object per line with the level, the event and the bindings", () => {
    const { logger, events } = memoryLogger();
    logger.child({ bot: "runner" }).info("delivery_outcome", { gas: 21_000n, nested: { wei: 5n } });
    expect(events()).toEqual([{ time: "1970-01-01T00:00:00.000Z", level: "info", event: "delivery_outcome", bot: "runner", gas: "21000", nested: { wei: "5" } }]);
  });

  it("removes keys by shape and by value, in fields and in errors", () => {
    const { logger, lines } = memoryLogger(["hunter2hunter2"]);
    logger.error("failed", {
      url: `https://one.valve.city/rpc/${VALVE_KEY}/evm/369`,
      error: new Error(`401 for key ${RUNPOD_KEY} and password hunter2hunter2`),
      header: `Authorization: Bearer abcdefghijklmnop`,
    });
    const text = lines.join("\n");
    for (const secret of [VALVE_KEY, RUNPOD_KEY, "hunter2hunter2", "abcdefghijklmnop"]) expect(text).not.toContain(secret);
    expect(text).toContain("[redacted]");
  });

  it("drops lines below the minimum level", () => {
    const lines: string[] = [];
    const logger = createLogger({ write: (line) => lines.push(line), now: () => new Date(0), knownSecrets: () => [], minimumLevel: "warn" });
    logger.debug("a");
    logger.info("b");
    logger.warn("c");
    expect(lines).toHaveLength(1);
  });
});

describe("the bot configuration", () => {
  const minimal = { schemaVersion: 1, stateDirectory: "/var/lib/bots" };

  it("fills the defaults and keeps a secret out of the file", () => {
    const config = parseBotConfig({
      ...minimal,
      publisher: { prover: { binary: "/usr/local/bin/zk-bridge-prover" } },
      runner: {
        prover: { binary: "/usr/local/bin/zk-bridge-prover" },
        indexerUrl: "http://127.0.0.1:42069",
        signer: { kind: "private-key", key: "env:RUNNER_PRIVATE_KEY" },
        maximumPrerequisiteSpendPerSweepWei: "5000", maximumPrerequisiteSpendPerDayWei: "20000", maximumUnrecoveredPrerequisiteLossWei: "10000",
      },
    });
    expect(config.maximumMessageBytes).toBe(8192);
    expect(config.publisher?.apiKeyVariable).toBe("RUNPOD_API_KEY");
    expect(config.publisher?.remote).toEqual({ mode: "load-balancing" });
    expect(config.runner?.signer).toEqual({ kind: "private-key", key: { source: "environment", variable: "RUNNER_PRIVATE_KEY" } });
    expect(config.runner?.maximumLossPercent).toBe(20);
    expect(config.runner?.proofCheckGas).toBe(400_000);
    expect(config.runner?.deliverWithoutOffer).toBe(false);
    expect(config.runner?.prerequisiteGasFallback).toBe(300_000);
    expect(config.runner?.prerequisiteLossRefusalSeconds).toBe(1800);
    expect(config.runner?.maximumBatchSize).toBe(5);
    expect(config.runner?.maximumBatchGas).toBe(6_000_000);
  });

  it("refuses a reward address in the runner section, because the router decides where the tips go", () => {
    const runner = {
      prover: { binary: "p" },
      indexerUrl: "http://127.0.0.1:1",
      signer: { kind: "private-key", key: "env:RUNNER_PRIVATE_KEY" },
      maximumPrerequisiteSpendPerSweepWei: "5000",
      maximumPrerequisiteSpendPerDayWei: "20000",
      maximumUnrecoveredPrerequisiteLossWei: "10000",
      rewardAddress: "0x1111111111111111111111111111111111111111",
    };
    expect(() => parseBotConfig({ ...minimal, runner })).toThrow(/rewardAddress/);
  });

  it("refuses minimumMarginWei and names maximumLossPercent", () => {
    const runner = (extra: Record<string, unknown>) => ({
      prover: { binary: "p" },
      indexerUrl: "http://127.0.0.1:1",
      signer: { kind: "private-key", key: "env:RUNNER_PRIVATE_KEY" },
      maximumPrerequisiteSpendPerSweepWei: "5000",
      maximumPrerequisiteSpendPerDayWei: "20000",
      maximumUnrecoveredPrerequisiteLossWei: "10000",
      ...extra,
    });
    expect(() => parseBotConfig({ ...minimal, runner: runner({ minimumMarginWei: "0" }) })).toThrow(/config\.runner\.minimumMarginWei.*runner\.maximumLossPercent/);
    expect(() => parseBotConfig({ ...minimal, runner: runner({ executionGasFallback: 900_000 }) })).toThrow(/config\.runner\.executionGasFallback.*runner\.proofCheckGas/);
    expect(() => parseBotConfig({ ...minimal, runner: runner({ maximumLossPercent: 101 }) })).toThrow(/config\.runner\.maximumLossPercent/);
    expect(parseBotConfig({ ...minimal, runner: runner({ maximumLossPercent: 0 }) }).runner?.maximumLossPercent).toBe(0);
    expect(() => parseBotConfig({ ...minimal, runner: "text" })).toThrow();
    expect(() => parseBotConfig("text")).toThrow();
  });

  it("checks the batch limits", () => {
    const runner = (extra: Record<string, unknown>) => ({
      prover: { binary: "p" },
      indexerUrl: "http://127.0.0.1:1",
      signer: { kind: "private-key", key: "env:RUNNER_PRIVATE_KEY" },
      maximumPrerequisiteSpendPerSweepWei: "5000",
      maximumPrerequisiteSpendPerDayWei: "20000",
      maximumUnrecoveredPrerequisiteLossWei: "10000",
      ...extra,
    });
    expect(parseBotConfig({ ...minimal, runner: runner({ maximumBatchSize: 3, maximumBatchGas: 2_000_000 }) }).runner).toMatchObject({ maximumBatchSize: 3, maximumBatchGas: 2_000_000 });
    expect(() => parseBotConfig({ ...minimal, runner: runner({ maximumBatchSize: 0 }) })).toThrow(/config\.runner\.maximumBatchSize/);
    expect(() => parseBotConfig({ ...minimal, runner: runner({ maximumBatchGas: -1 }) })).toThrow(/config\.runner\.maximumBatchGas/);
  });

  it("takes a minimum priority fee by chain id over the defaults of PulseChain and its testnet", () => {
    const runner = (extra: Record<string, unknown>) => ({
      prover: { binary: "p" },
      indexerUrl: "http://127.0.0.1:1",
      signer: { kind: "private-key", key: "env:RUNNER_PRIVATE_KEY" },
      maximumPrerequisiteSpendPerSweepWei: "5000",
      maximumPrerequisiteSpendPerDayWei: "20000",
      maximumUnrecoveredPrerequisiteLossWei: "10000",
      ...extra,
    });
    const plain = parseBotConfig({ ...minimal, runner: runner({}) }).runner!;
    expect(plain.minimumPriorityFeeWei).toEqual({});
    expect(runnerMinimumPriorityFeeWei(plain, 943)).toBe(10_000_000n);
    expect(runnerMinimumPriorityFeeWei(plain, 369)).toBe(10_000_000n);
    expect(runnerMinimumPriorityFeeWei(plain, 11155111)).toBe(0n);
    const set = parseBotConfig({ ...minimal, runner: runner({ minimumPriorityFeeWei: { "943": "2000000", "11155111": "1" } }) }).runner!;
    expect(runnerMinimumPriorityFeeWei(set, 943)).toBe(2_000_000n);
    expect(runnerMinimumPriorityFeeWei(set, 11155111)).toBe(1n);
    expect(() => parseBotConfig({ ...minimal, runner: runner({ minimumPriorityFeeWei: { sepolia: "1" } }) })).toThrow(/config\.runner\.minimumPriorityFeeWei/);
    expect(() => parseBotConfig({ ...minimal, runner: runner({ minimumPriorityFeeWei: { "943": "0.01" } }) })).toThrow(/config\.runner\.minimumPriorityFeeWei/);
  });

  it("refuses a runner without a cap on the layout spend of a sweep, because the cap bounds an attack on the runner gas", () => {
    const runner = { prover: { binary: "p" }, indexerUrl: "http://127.0.0.1:1", signer: { kind: "private-key", key: "env:RUNNER_PRIVATE_KEY" } };
    expect(() => parseBotConfig({ ...minimal, runner })).toThrow(/config\.runner\.maximumPrerequisiteSpendPerSweepWei/);
  });

  it("accepts a 1Password reference and refuses a secret typed where a reference belongs", () => {
    const runner = (key: string) => ({ prover: { binary: "p" }, indexerUrl: "http://127.0.0.1:1", signer: { kind: "private-key", key }, maximumPrerequisiteSpendPerSweepWei: "5000", maximumPrerequisiteSpendPerDayWei: "20000", maximumUnrecoveredPrerequisiteLossWei: "10000" });
    expect(parseBotConfig({ ...minimal, runner: runner("op://vault/item/field") }).runner?.signer).toMatchObject({ key: { source: "onepassword" } });
    expect(() => parseBotConfig({ ...minimal, runner: runner(`0x${"ab".repeat(32)}`) })).toThrow(BotConfigError);
  });

  it("refuses an unknown key and a remote mode that does not exist yet", () => {
    expect(() => parseBotConfig({ ...minimal, surprise: 1 })).toThrow(BotConfigError);
    expect(() => parseBotConfig({ ...minimal, publisher: { prover: { binary: "p" }, remote: { mode: "queue" } } })).toThrow(BotConfigError);
  });

  it("reads an endpoint list for the remote backend and refuses a bad one", () => {
    const endpoints = [
      { label: "dedicated", url: "http://203.0.113.7:40123", readyWaitSeconds: 20, timeoutSeconds: 120, attempts: 2 },
      { label: "serverless", url: "https://abc123.api.runpod.ai", apiKeyVariable: "RUNPOD_API_KEY" },
    ];
    const withList = (list: unknown) => ({ ...minimal, publisher: { prover: { binary: "p" }, remote: { mode: "load-balancing", endpoints: list } } });
    expect(parseBotConfig(withList(endpoints)).publisher?.remote).toEqual({ mode: "load-balancing", endpoints });
    expect(() => parseBotConfig(withList([]))).toThrow(BotConfigError);
    expect(() => parseBotConfig(withList([{ ...endpoints[1], url: "http://abc123.api.runpod.ai" }]))).toThrow(/https/);
    expect(() => parseBotConfig(withList([endpoints[0], { ...endpoints[1], label: "dedicated" }]))).toThrow(/own label/);
  });

  it("names the field of the first problem", () => {
    expect(() => parseBotConfig({ schemaVersion: 1 })).toThrow(/config\.stateDirectory/);
  });
});

describe("the example configuration", () => {
  it("is valid, and holds no secret value", async () => {
    const text = await readFile(new URL("../../bots.example.json", import.meta.url), "utf8");
    const config = parseBotConfig(JSON.parse(text));
    expect(config.publisher?.remote).toEqual({ mode: "load-balancing" });
    expect(config.runner?.signer).toMatchObject({ kind: "private-key", key: { source: "onepassword" } });
    expect(text).not.toMatch(/0x[0-9a-fA-F]{64}/);
  });
});

describe("the command line", () => {
  it("reads a role, a configuration file and --once", () => {
    expect(parseCommandLine(["runner", "--config", "bots.json", "--once"])).toEqual({ role: "runner", configPath: "bots.json", runOnce: true });
    expect(parseCommandLine(["publisher", "--config", "bots.json"])).toEqual({ role: "publisher", configPath: "bots.json", runOnce: false });
  });

  it("refuses an unknown role, a missing file and a stray flag", () => {
    expect(() => parseCommandLine(["relayer", "--config", "x"])).toThrow(BotConfigError);
    expect(() => parseCommandLine(["runner"])).toThrow(/--config/);
    expect(() => parseCommandLine(["runner", "--config", "x", "--private-key", "y"])).toThrow(/Unknown argument/);
  });
});

describe("the secret vault", () => {
  const run = async () => ({ code: 0, stdout: "", stderr: "" });

  it("reads an environment variable and remembers the value for the logger", async () => {
    const vault = createSecretVault({ store: null, environment: { RUNPOD_API_KEY: RUNPOD_KEY }, run });
    expect(await vault.resolve({ source: "environment", variable: "RUNPOD_API_KEY" })).toBe(RUNPOD_KEY);
    expect(vault.knownSecrets()).toEqual([RUNPOD_KEY]);
    await expect(vault.resolve({ source: "environment", variable: "MISSING" })).rejects.toThrow(/MISSING/);
    expect(await vault.resolveOptional(null)).toBeNull();
  });

  it("reads a 1Password reference through `op read`, and never puts the secret on the command line", async () => {
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const vault = createSecretVault({
      store: null,
      environment: {},
      run: async (command, args) => {
        calls.push({ command, args });
        return { code: 0, stdout: VALVE_KEY, stderr: "" };
      },
    });
    expect(await vault.resolve({ source: "onepassword", reference: "op://vault/item/field" })).toBe(VALVE_KEY);
    expect(calls).toEqual([{ command: "op", args: ["read", "--no-newline", "op://vault/item/field"] }]);
  });

  it("reads the encrypted secret file of the dashboard with the password from the environment", async () => {
    const directory = await scratchDirectory();
    const file = join(directory, "secrets.enc.json");
    const first = await openSecretStore({ settings: { kind: "encrypted-file", file, passwordVariable: "BOT_SECRET_PASSWORD" }, environment: { BOT_SECRET_PASSWORD: "correct horse battery" }, platform: "linux", run });
    await first?.set("explorer.prover.runpod-api-key", RUNPOD_KEY);
    const store = await openSecretStore({ settings: { kind: "encrypted-file", file, passwordVariable: "BOT_SECRET_PASSWORD" }, environment: { BOT_SECRET_PASSWORD: "correct horse battery" }, platform: "linux", run });
    const vault = createSecretVault({ store, environment: {}, run });
    expect(await vault.resolve({ source: "store", name: "explorer.prover.runpod-api-key" })).toBe(RUNPOD_KEY);
    await expect(openSecretStore({ settings: { kind: "encrypted-file", file, passwordVariable: "BOT_SECRET_PASSWORD" }, environment: {}, platform: "linux", run })).rejects.toThrow(/passwordVariable/);
  });
});

describe("the state file", () => {
  const schema = z.object({ count: z.number() });

  it("starts from the initial state, writes atomically with mode 0600, and reads back", async () => {
    const directory = await scratchDirectory();
    const file = createStateFile({ path: join(directory, "nested", "state.json"), schema, initial: { count: 0 } });
    expect(await file.load()).toEqual({ count: 0 });
    await file.save({ count: 3 });
    expect(await file.load()).toEqual({ count: 3 });
    expect((await stat(join(directory, "nested", "state.json"))).mode & 0o777).toBe(0o600);
  });

  it("stops instead of starting over when the file is damaged", async () => {
    const directory = await scratchDirectory();
    const path = join(directory, "state.json");
    const file = createStateFile({ path, schema, initial: { count: 0 } });
    await writeFile(path, "{ not json");
    await expect(file.load()).rejects.toBeInstanceOf(StateFileError);
    await writeFile(path, JSON.stringify({ count: "three" }));
    await expect(file.load()).rejects.toBeInstanceOf(StateFileError);
  });
});

describe("the outcome file", () => {
  it("appends one redacted JSON line per outcome with amounts as decimal text, mode 0600", async () => {
    const directory = await scratchDirectory();
    const path = join(directory, "outcomes.jsonl");
    const sink = createFileOutcomeSink({ path, now: () => new Date(0), knownSecrets: () => [RUNPOD_KEY] });
    await sink.record({ kind: "delivery", pair: "eth-pls", direction: "first-to-second", status: "skipped", reason: "loss-at-or-above-limit", feeWei: 5n, detail: `key ${RUNPOD_KEY}` });
    await sink.record({ kind: "update", pair: "eth-pls", direction: "first-to-second", status: "posted", gasUsed: 123n });
    const lines = (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(lines[0]).toMatchObject({ time: "1970-01-01T00:00:00.000Z", status: "skipped", feeWei: "5" });
    expect(JSON.stringify(lines)).not.toContain(RUNPOD_KEY);
    expect(lines[1]).toMatchObject({ kind: "update", gasUsed: "123" });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
});

describe("small runtime parts", () => {
  it("runs queued jobs one at a time, in order, and goes on after a failure", async () => {
    const queue = createSerialQueue();
    const order: string[] = [];
    const slow = queue.run(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push("first");
    });
    const failing = queue.run(async () => {
      order.push("second");
      throw new Error("boom");
    });
    const last = queue.run(async () => order.push("third"));
    await slow;
    await expect(failing).rejects.toThrow("boom");
    await last;
    expect(order).toEqual(["first", "second", "third"]);
  });

  it("keeps the loop alive when a step throws, and stops on the signal", async () => {
    const { logger, events } = memoryLogger();
    const controller = new AbortController();
    let passes = 0;
    await runLoop({
      name: "test",
      intervalMilliseconds: 1,
      signal: controller.signal,
      runOnce: false,
      logger,
      step: async () => {
        passes += 1;
        if (passes === 1) throw new Error("first pass fails");
        if (passes === 3) controller.abort();
      },
    });
    expect(passes).toBe(3);
    expect(events().filter((event) => event.event === "step_failed")).toHaveLength(1);
  });

  it("runs exactly once when asked", async () => {
    let passes = 0;
    await runLoop({ name: "once", intervalMilliseconds: 1, signal: new AbortController().signal, runOnce: true, logger: memoryLogger().logger, step: async () => void (passes += 1) });
    expect(passes).toBe(1);
  });
});

