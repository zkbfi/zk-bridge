import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAddress, type Address, type PublicClient } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import { proofCategory } from "@zk-bridge/shared";
import { signerFromPrivateKeyText } from "../../../terminal/src/signing/key-sources.ts";
import { BotConfigError, parseBotConfig } from "../../src/config/bot-config.ts";
import type { BoardFeed, BoardMessage } from "../../src/msgboard/board.ts";
import { LockHeldError } from "../../src/runtime/lock-file.ts";
import { deliverySettingsOf, startRunner, type RunnerOverrides } from "../../src/runner/service.ts";
import { PROGRAM_KEY, fakeProver, proofPayload, word } from "../support/builders.ts";
import { startFakeBoard, type FakeBoard } from "../support/fake-board.ts";
import { startFakeIndexer, type FakeIndexer } from "../support/fake-indexer.ts";
import { createServiceWorld, type ServiceWorld, type ServiceWorldOptions } from "../support/service-world.ts";

// The first two public development keys of Anvil. Neither holds funds on a live chain.
const SIGNER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const SIGNER_ADDRESS = getAddress("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
const REWARD_ADDRESS = getAddress("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length > 0) await closers.pop()?.();
});

const runnerSection = (indexerUrl: string, extra: Record<string, unknown> = {}) => ({
  runner: {
    prover: { binary: "/bin/zk-bridge-prover" },
    indexerUrl,
    signer: { kind: "private-key", key: "env:RUNNER_KEY" },
    rewardAddress: REWARD_ADDRESS,
    maximumPrerequisiteSpendPerSweepWei: "5000",
    maximumPrerequisiteSpendPerDayWei: "20000",
    maximumUnrecoveredPrerequisiteLossWei: "10000",
    ...extra,
  },
});

interface Started {
  readonly created: ServiceWorld;
  readonly indexer: FakeIndexer;
  readonly node: FakeBoard;
}

async function prepare(options: ServiceWorldOptions & { runnerExtra?: Record<string, unknown>; directions?: Array<"first-to-second" | "second-to-first"> } = {}): Promise<Started> {
  const node = await startFakeBoard();
  closers.push(() => node.stop());
  const indexer = await startFakeIndexer();
  closers.push(() => indexer.stop());
  const created = await createServiceWorld({
    config: { ...runnerSection(indexer.url, options.runnerExtra), ...options.config },
    setup: { msgboardUrl: { source: "environment", variable: "BOARD_URL" }, directions: options.directions ?? ["first-to-second"], ...options.setup },
    environment: { RUNNER_KEY: SIGNER_KEY, BOARD_URL: node.url, PATH: "/custom/bin", ...options.environment },
    ...(options.omitFeeRouter === undefined ? {} : { omitFeeRouter: options.omitFeeRouter }),
  });
  closers.push(created.cleanup);
  return { created, indexer, node };
}

interface ClientAnswers {
  runner?: Address;
  rewardAddress?: Address;
  code?: string | undefined;
  failHead?: boolean;
}

function clientWith(answers: ClientAnswers = {}) {
  const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
    if (functionName === "runner") return answers.runner ?? SIGNER_ADDRESS;
    if (functionName === "rewardAddress") return answers.rewardAddress ?? REWARD_ADDRESS;
    if (functionName === "head" && answers.failHead === true) throw new Error("rpc down");
    if (functionName === "head") return 100n;
    if (functionName === "programVKey") return PROGRAM_KEY;
    return word(101);
  });
  const getCode = vi.fn(async () => ("code" in answers ? answers.code : "0x6080"));
  return { readContract, getCode } as unknown as PublicClient & { readContract: typeof readContract; getCode: typeof getCode };
}

function fakeFeed(recentMessages: BoardMessage[] = []) {
  const subscribers: Array<(message: BoardMessage) => void> = [];
  const closeSubscription = vi.fn(async () => undefined);
  const feed: BoardFeed & { subscribed: string[]; closed: number; recentCalls: string[] } = {
    subscribed: [],
    closed: 0,
    recentCalls: [],
    async subscribe(category, onMessage) {
      feed.subscribed.push(category);
      subscribers.push(onMessage);
      return { close: closeSubscription };
    },
    async recent(category) {
      feed.recentCalls.push(category);
      return recentMessages;
    },
    async close() {
      feed.closed += 1;
    },
  };
  return { feed, subscribers, closeSubscription };
}

async function waitForEvent(created: ServiceWorld, name: string): Promise<void> {
  for (let attempt = 0; attempt < 300 && !created.events().some((event) => event.event === name); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  expect(created.events().some((event) => event.event === name)).toBe(true);
}

function run(started: Started, overrides: RunnerOverrides, options: { runOnce?: boolean; signal?: AbortSignal } = {}) {
  return startRunner({ context: started.created.context, signal: options.signal ?? new AbortController().signal, runOnce: options.runOnce ?? true, overrides });
}

function standardOverrides(extra: RunnerOverrides = {}) {
  const client = clientWith();
  const { feed, ...feedParts } = fakeFeed();
  const signer = signerFromPrivateKeyText(SIGNER_KEY);
  const dispose = vi.spyOn(signer, "dispose");
  const makeClient = vi.fn((_rpcUrl: string) => client);
  const overrides: RunnerOverrides = { feed, signer, publicClient: makeClient, prover: () => fakeProver(), now: () => 1_800_000_000_000, ...extra };
  return { overrides, client, feed, makeClient, dispose, ...feedParts };
}

describe("deliverySettingsOf", () => {
  it("reads every wei text as a number and lowercases the token addresses of the valuations", () => {
    const parsed = parseBotConfig({
      schemaVersion: 1,
      stateDirectory: "/s",
      ...runnerSection("http://127.0.0.1:1", {
        minimumMarginWei: "7",
        deliverWithoutOffer: true,
        tokenValuationsWei: { [`0x${"AB".repeat(20)}`]: "1000" },
        executionGasFallback: 11,
        maximumPrerequisiteRounds: 2,
        prerequisiteGasFallback: 13,
        maximumBatchSize: 3,
        maximumBatchGas: 17,
      }),
    }).runner!;
    expect(deliverySettingsOf(parsed)).toEqual({
      minimumMarginWei: 7n,
      deliverWithoutOffer: true,
      tokenValuationsWei: { [`0x${"ab".repeat(20)}`]: 1000n },
      executionGasFallback: 11n,
      maximumPrerequisiteRounds: 2,
      prerequisiteGasFallback: 13n,
      maximumPrerequisiteSpendPerSweepWei: 5000n,
      maximumPrerequisiteSpendPerDayWei: 20000n,
      maximumUnrecoveredPrerequisiteLossWei: 10000n,
      maximumBatchSize: 3,
      maximumBatchGas: 17n,
    });
  });
});

describe("startRunner refuses to start", () => {
  it("without a runner section", async () => {
    const started = await prepare({ config: { runner: undefined } });
    await expect(run(started, standardOverrides().overrides)).rejects.toThrow(new BotConfigError("The bot configuration has no runner section."));
  });

  it("without a msgboard endpoint, and then holds no lock", async () => {
    const started = await prepare({ setup: { msgboardUrl: null } });
    await expect(run(started, standardOverrides().overrides)).rejects.toThrow("The setup file has no msgboard endpoint (msgboardUrl).");
    expect(existsSync(join(started.created.directory, "state", "runner-eth-pls-first-to-second.json.lock"))).toBe(false);
  });

  it("while a live process holds the lock of a direction", async () => {
    const started = await prepare();
    const state = join(started.created.directory, "state");
    await mkdir(state, { recursive: true });
    await writeFile(join(state, "runner-eth-pls-first-to-second.json.lock"), `${process.pid}\n`);
    const { overrides, makeClient } = standardOverrides();
    await expect(run(started, overrides)).rejects.toBeInstanceOf(LockHeldError);
    expect(makeClient).not.toHaveBeenCalled();
  });

  it("when the fee router does not whitelist the signer, and releases the lock", async () => {
    const started = await prepare();
    const { overrides } = standardOverrides({ publicClient: () => clientWith({ runner: REWARD_ADDRESS }) });
    await expect(run(started, overrides)).rejects.toThrow(/whitelists/);
    expect(existsSync(join(started.created.directory, "state", "runner-eth-pls-first-to-second.json.lock"))).toBe(false);
  });

  it("when the fee router pays another address than the reward address", async () => {
    const started = await prepare();
    const { overrides } = standardOverrides({ publicClient: () => clientWith({ rewardAddress: SIGNER_ADDRESS }) });
    await expect(run(started, overrides)).rejects.toThrow(/pays the fees to/);
  });

  it.each([["undefined", undefined], ["empty", "0x"]])("when Multicall3 holds no code (%s)", async (_name, code) => {
    const started = await prepare();
    const { overrides } = standardOverrides({ publicClient: () => clientWith({ code }) });
    await expect(run(started, overrides)).rejects.toThrow(/runner\.multicall3 0xcA11bde05977b3631167028862bE2a173976CA11 holds no code on /);
  });

  it("when the real client cannot reach the chain", async () => {
    const started = await prepare();
    const { overrides } = standardOverrides();
    const { publicClient: _unused, ...withoutClient } = overrides;
    await expect(run(started, withoutClient)).rejects.toThrow(/Cannot read runner\(\) of the fee router/);
  }, 60_000);
});

describe("startRunner runs one pass", () => {
  it("checks the router and Multicall3, reads the board, sweeps, and shuts everything down", async () => {
    const started = await prepare();
    const { overrides, feed, dispose, makeClient, client } = standardOverrides();
    await run(started, overrides);
    expect(feed.subscribed).toEqual([]);
    expect(feed.recentCalls).toEqual([proofCategory("eth-pls", "first-to-second")]);
    expect(feed.closed).toBe(1);
    expect(dispose).toHaveBeenCalledOnce();
    expect(client.getCode).toHaveBeenCalledWith({ address: "0xcA11bde05977b3631167028862bE2a173976CA11" });
    expect(existsSync(join(started.created.directory, "state", "runner-eth-pls-first-to-second.json.lock"))).toBe(false);
    expect(makeClient.mock.calls.map(([url]) => url).sort()).toEqual(["http://127.0.0.1:1", "http://127.0.0.1:2"]);
    const events = started.created.events();
    expect(events.find((event) => event.event === "runner_signer_ready")).toMatchObject({ address: SIGNER_ADDRESS, kind: "private-key" });
    expect(events.find((event) => event.event === "runner_started")).toMatchObject({
      direction: "first-to-second",
      category: proofCategory("eth-pls", "first-to-second"),
      pollSeconds: 30,
      rewardAddress: REWARD_ADDRESS,
    });
    expect(events.find((event) => event.event === "runner_sweep")).toMatchObject({ level: "debug", bot: "runner" });
  });

  it("shares one client and one send queue for a chain between the two directions", async () => {
    const started = await prepare({ directions: ["first-to-second", "second-to-first"] });
    const { overrides, makeClient, feed } = standardOverrides();
    await run(started, overrides);
    expect(makeClient).toHaveBeenCalledTimes(2);
    expect(feed.recentCalls.sort()).toEqual([proofCategory("eth-pls", "first-to-second"), proofCategory("eth-pls", "second-to-first")].sort());
    expect(started.created.events().filter((event) => event.event === "runner_started")).toHaveLength(2);
  });

  it("opens the signer from the configuration when none is given, and keeps its key out of the log", async () => {
    const started = await prepare();
    const { overrides } = standardOverrides();
    const { signer: _unused, ...withoutSigner } = overrides;
    await run(started, withoutSigner);
    expect(started.created.events().find((event) => event.event === "runner_signer_ready")).toMatchObject({ address: SIGNER_ADDRESS });
    expect(started.created.logLines.join("\n")).not.toContain(SIGNER_KEY);
  });

  it("delivers without a router when the deployment has none, and needs no reward address and no Multicall3", async () => {
    const started = await prepare({ omitFeeRouter: true });
    const { overrides, client } = standardOverrides({ publicClient: () => clientWith({ code: undefined }) });
    await run(started, overrides);
    expect(started.created.events().find((event) => event.event === "runner_started")).toMatchObject({ feeRouter: null, rewardAddress: null });
    expect(client.getCode).not.toHaveBeenCalled();
  });

  it("uses the router that the configuration names over the one in the deployment", async () => {
    const named = `0x${"5a".repeat(20)}`;
    const started = await prepare({ runnerExtra: { feeRouter: named } });
    const { overrides } = standardOverrides();
    await run(started, overrides);
    expect(started.created.events().find((event) => event.event === "runner_started")).toMatchObject({ feeRouter: named });
  });

  it("builds the prover wrapper itself when none is given, and reads the priority fee that the configuration sets", async () => {
    const started = await prepare({ runnerExtra: { priorityFeeWei: "5" } });
    const { overrides } = standardOverrides();
    const { prover: _unused, ...withoutProver } = overrides;
    await run(started, withoutProver);
    expect(started.created.events().some((event) => event.event === "runner_started")).toBe(true);
  });

  it("reads the real board and uses the real clock when no feed and no clock are given", async () => {
    const started = await prepare();
    const { overrides } = standardOverrides();
    const { feed: _feed, now: _now, ...rest } = overrides;
    await run(started, rest);
    expect(started.node.requests.some((request) => request.method === "msgboard_content")).toBe(true);
    expect(started.created.events().find((event) => event.event === "runner_sweep")).toBeDefined();
  });
});

describe("startRunner keeps running until the signal fires", () => {
  it("subscribes to the category, passes each message to the runner, and closes everything on the signal", async () => {
    const started = await prepare();
    const { overrides, feed, subscribers, closeSubscription, dispose } = standardOverrides();
    const controller = new AbortController();
    const done = run(started, overrides, { runOnce: false, signal: controller.signal });
    for (let attempt = 0; attempt < 200 && subscribers.length === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(feed.subscribed).toEqual([proofCategory("eth-pls", "first-to-second")]);
    subscribers[0]!({ category: proofCategory("eth-pls", "first-to-second"), data: "0x01", hash: word(1) });
    await waitForEvent(started.created, "proof_refused");
    controller.abort();
    await done;
    expect(started.created.events().find((event) => event.event === "proof_refused")).toMatchObject({ level: "debug", reason: "undecodable" });
    expect(closeSubscription).toHaveBeenCalledOnce();
    expect(feed.closed).toBe(1);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("logs a message that the runner cannot process, instead of stopping", async () => {
    const started = await prepare();
    const { overrides, subscribers } = standardOverrides();
    const controller = new AbortController();
    const done = run(started, overrides, { runOnce: false, signal: controller.signal });
    for (let attempt = 0; attempt < 200 && subscribers.length === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    subscribers[0]!({ category: proofCategory("eth-pls", "first-to-second"), data: proofPayload(), hash: word(1) });
    await waitForEvent(started.created, "proof_message_failed");
    controller.abort();
    await done;
    // The client of the test has no `getBlock`, so the first step that needs a fee quote fails. The bot goes on.
    expect(started.created.events().find((event) => event.event === "proof_message_failed")).toMatchObject({
      level: "error",
      bot: "runner",
      direction: "first-to-second",
      error: { name: "TypeError", message: "client.getBlock is not a function" },
    });
  });
});
