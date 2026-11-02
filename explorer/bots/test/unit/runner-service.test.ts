import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAddress, type Address, type PublicClient } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import { proofCategory } from "@zk-bridge/shared";
import { describeRoute } from "@zk-bridge/shared/prover";
import { signerFromPrivateKeyText } from "../../../terminal/src/signing/key-sources.ts";
import { BotConfigError, parseBotConfig } from "../../src/config/bot-config.ts";
import type { BoardFeed, BoardMessage } from "@zk-bridge/shared/msgboard";
import { LockHeldError } from "../../src/runtime/lock-file.ts";
import { deliverySettingsOf, startRunner, type RunnerOverrides } from "../../src/runner/service.ts";
import { PROGRAM_KEY, fakeProver, proofPayload, word } from "../support/builders.ts";
import { startFakeBoard, type FakeBoard } from "../../../shared/test/support/fake-board.ts";
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
    ...(options.omitDeliveryRouter === undefined ? {} : { omitDeliveryRouter: options.omitDeliveryRouter }),
  });
  closers.push(created.cleanup);
  return { created, indexer, node };
}

interface ClientAnswers {
  rewardAddress?: Address;
  failRewardRead?: boolean;
  code?: string | undefined;
  failHead?: boolean;
  /** The answer of `depositsOpen()` of the bridge. Default: open. */
  depositsOpen?: boolean;
}

function clientWith(answers: ClientAnswers = {}) {
  const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
    if (functionName === "rewardAddress" && answers.failRewardRead === true) throw new Error("execution reverted");
    if (functionName === "rewardAddress") return answers.rewardAddress ?? REWARD_ADDRESS;
    if (functionName === "head" && answers.failHead === true) throw new Error("rpc down");
    if (functionName === "head") return 100n;
    if (functionName === "programVKey") return PROGRAM_KEY;
    if (functionName === "depositsOpen") return answers.depositsOpen ?? true;
    if (functionName === "genesisTime") return 1_606_824_023n;
    if (functionName === "secondsPerSlot") return 12n;
    return word(101);
  });
  const getCode = vi.fn(async () => ("code" in answers ? answers.code : "0x6080"));
  return { readContract, getCode, getBlockNumber: async () => 900n } as unknown as PublicClient & { readContract: typeof readContract; getCode: typeof getCode };
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

function run(started: Started, overrides: RunnerOverrides | undefined, options: { runOnce?: boolean; signal?: AbortSignal } = {}) {
  return startRunner({ context: started.created.context, signal: options.signal ?? new AbortController().signal, runOnce: options.runOnce ?? true, ...(overrides === undefined ? {} : { overrides }) });
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
        maximumLossPercent: 7,
        deliverWithoutOffer: true,
        tokenValuationsWei: { [`0x${"AB".repeat(20)}`]: "1000" },
        proofCheckGas: 11,
        maximumPrerequisiteRounds: 2,
        prerequisiteGasFallback: 13,
        maximumBatchSize: 3,
        maximumBatchGas: 17,
      }),
    }).runner!;
    expect(deliverySettingsOf(parsed)).toEqual({
      maximumLossPercent: 7,
      deliverWithoutOffer: true,
      tokenValuationsWei: { [`0x${"ab".repeat(20)}`]: 1000n },
      proofCheckGas: 11n,
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
    await expect(run(started, undefined)).rejects.toThrow("The setup file has no msgboard endpoint (msgboardUrl).");
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

  it("when the reward address of the delivery router cannot be read, names the router and the chain, and releases the lock", async () => {
    const started = await prepare();
    const { overrides } = standardOverrides({ publicClient: () => clientWith({ failRewardRead: true }) });
    await expect(run(started, overrides)).rejects.toThrow(/Cannot read rewardAddress\(\) of the delivery router 0x\w+ on .+: execution reverted/);
    expect(existsSync(join(started.created.directory, "state", "runner-eth-pls-first-to-second.json.lock"))).toBe(false);
  });

  it("reads the reward address from the router and logs it, with no check against the signer", async () => {
    const started = await prepare();
    const { overrides } = standardOverrides({ publicClient: () => clientWith({ rewardAddress: SIGNER_ADDRESS }) });
    await run(started, overrides);
    expect(started.created.events().find((event) => event.event === "runner_started")).toMatchObject({ rewardAddress: SIGNER_ADDRESS });
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
    await expect(run(started, withoutClient)).rejects.toThrow(/Cannot read rewardAddress\(\) of the delivery router/);
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

  it("delivers without a router when the deployment has none, and reads no reward address and needs no Multicall3", async () => {
    const started = await prepare({ omitDeliveryRouter: true });
    const { overrides, client } = standardOverrides({ publicClient: () => clientWith({ code: undefined }) });
    await run(started, overrides);
    expect(started.created.events().find((event) => event.event === "runner_started")).toMatchObject({ deliveryRouter: null, rewardAddress: null });
    expect(client.getCode).not.toHaveBeenCalled();
  });

  it("uses the router that the configuration names over the one in the deployment", async () => {
    const named = `0x${"5a".repeat(20)}`;
    const started = await prepare({ runnerExtra: { deliveryRouter: named } });
    const { overrides } = standardOverrides();
    await run(started, overrides);
    expect(started.created.events().find((event) => event.event === "runner_started")).toMatchObject({ deliveryRouter: named });
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

describe("startRunner opens the bridge of the destination chain", () => {
  const stateOf = (started: Started) => JSON.parse(readFileSync(join(started.created.directory, "state", "runner-eth-pls-first-to-second.json"), "utf8")) as { depositsOpen: boolean };

  it("checks the bridge at start, and records an open bridge in the state file", async () => {
    const started = await prepare();
    const { overrides, client } = standardOverrides();
    await run(started, overrides);
    const bridge = started.created.context.pair.sides[1].contracts.bridge;
    expect(client.readContract).toHaveBeenCalledWith({ address: bridge, abi: expect.anything(), functionName: "depositsOpen" });
    expect(started.created.events().find((event) => event.event === "deposits_open_checked")).toMatchObject({ bridge, open: true, direction: "first-to-second" });
    expect(started.created.events().find((event) => event.event === "runner_started")).toMatchObject({ openDeposits: true });
    expect(stateOf(started).depositsOpen).toBe(true);
  });

  it("reads nothing when runner.openDeposits is false", async () => {
    const started = await prepare({ runnerExtra: { openDeposits: false } });
    const { overrides, client } = standardOverrides();
    await run(started, overrides);
    expect(client.readContract.mock.calls.some(([call]) => call.functionName === "depositsOpen")).toBe(false);
    expect(started.created.events().find((event) => event.event === "runner_started")).toMatchObject({ openDeposits: false });
  });

  it("runs opening-proof of the opposite route with the prover of the configuration when the bridge is closed", async () => {
    const started = await prepare();
    const specs: Array<{ args: readonly string[] }> = [];
    const { overrides } = standardOverrides({
      publicClient: () => clientWith({ depositsOpen: false }),
      executor: async (spec) => {
        specs.push(spec);
        return { code: 1, stdout: "", stderr: "rpc error 4444/-32602: distance to target block exceeds maximum proof window" };
      },
    });
    await run(started, overrides);
    const route = describeRoute(started.created.context.pair, "second-to-first").name;
    expect(specs.map((spec) => spec.args.slice(2))).toEqual([["opening-proof", "--route", route]]);
    expect(started.created.events().find((event) => event.event === "deposits_open_failed")).toMatchObject({ level: "warn", reason: "proof-failed", route, failures: 1 });
    // Nothing to record: the state file was not written.
    expect(existsSync(join(started.created.directory, "state", "runner-eth-pls-first-to-second.json"))).toBe(false);
  });

  it("prefetches the opening proof of the source chain into the proof cache while the bridge is closed, and names the cache in the opening-proof config", async () => {
    const started = await prepare();
    const genesis = 1_606_824_023n;
    // Block 899 is at slot 63 and block 900 at slot 64, the first slot of an epoch: block 900 is a checkpoint.
    const base = clientWith({ depositsOpen: false });
    const request = vi.fn(async (_args: unknown) => ({ accountProof: ["0x01"], storageProof: [] }));
    const client = {
      ...base,
      getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({ number: blockNumber, hash: word(Number(blockNumber % 200n)), timestamp: genesis + (blockNumber - 836n) * 12n }),
      request,
    } as unknown as PublicClient;
    const configs: string[] = [];
    const { overrides } = standardOverrides({
      publicClient: () => client,
      executor: async (spec) => {
        configs.push(readFileSync(spec.args[1] as string, "utf8"));
        return { code: 1, stdout: "", stderr: "distance to target block exceeds maximum proof window" };
      },
    });
    await run(started, overrides);
    const cacheDirectory = join(started.created.directory, "state", "proof-cache");
    const lightClient = started.created.context.pair.sides[0].contracts.lightClient.toLowerCase();
    const file = join(cacheDirectory, "1", lightClient, `900-${word(900 % 200)}.json`);
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ chainId: 1, blockNumber: 900, address: lightClient, storedSlot: 100, proof: { accountProof: ["0x01"] } });
    expect(request).toHaveBeenCalledWith({ method: "eth_getProof", params: [started.created.context.pair.sides[0].contracts.lightClient, [expect.any(String)], "0x384"] });
    expect(started.created.events().find((event) => event.event === "proof_prefetched")).toMatchObject({ chainId: 1, blockNumber: "900", direction: "first-to-second" });
    expect(configs[0]).toContain(`proof_cache_dir = "${cacheDirectory}"`);
  });

  it("does not prefetch once the state file records the bridge as open", async () => {
    const started = await prepare();
    await mkdir(join(started.created.directory, "state"), { recursive: true });
    await writeFile(join(started.created.directory, "state", "runner-eth-pls-first-to-second.json"), JSON.stringify({ schemaVersion: 1, finished: {}, depositsOpen: true }));
    const { overrides } = standardOverrides();
    await run(started, overrides);
    expect(started.created.events().find((event) => event.event === "proof_prefetch_stopped")).toMatchObject({ chainId: 1, reason: "deposits-open" });
    expect(started.created.events().some((event) => event.event === "proof_prefetched")).toBe(false);
  });

  it("uses the opening prover that the overrides give, with the direction of the opposite route", async () => {
    const started = await prepare();
    const openingProver = vi.fn((_direction: string) => ({
      openingProof: async () => ({ route: "x", to: `0x${"ab".repeat(20)}`, calldata: "0x", chainId: 369, depositsOpen: false, remoteBlockNumber: 1, proof: { remoteSlot: 1, storedSlot: 1 } }),
    }));
    const { overrides } = standardOverrides({ publicClient: () => clientWith({ depositsOpen: false }), openingProver });
    await run(started, overrides);
    expect(openingProver).toHaveBeenCalledWith("second-to-first");
    expect(started.created.events().find((event) => event.event === "deposits_open_failed")).toMatchObject({ reason: "wrong-target" });
  });
});

describe("startRunner with a proof on the board", () => {
  /** A client that answers the chain reads, and reverts every call so that the update is skipped. */
  function revertingClient() {
    const client = clientWith();
    return Object.assign(client, {
      getBlock: async () => ({ baseFeePerGas: 10n }),
      estimateMaxPriorityFeePerGas: async () => 0n,
      call: async () => {
        throw new Error("execution reverted");
      },
    });
  }

  async function runWithProof(environment: Record<string, string | undefined>) {
    const started = await prepare({ environment });
    const specs: Array<{ command: string; args: readonly string[]; environment: Readonly<Record<string, string>> }> = [];
    const { feed } = fakeFeed([{ category: proofCategory("eth-pls", "first-to-second"), data: proofPayload(), hash: word(1) }]);
    const overrides = standardOverrides({
      feed,
      publicClient: () => revertingClient(),
      executor: async (spec) => {
        specs.push(spec);
        return { code: 0, stdout: `${JSON.stringify({ valid: true, programKey: PROGRAM_KEY })}\n`, stderr: "" };
      },
    }).overrides;
    const { prover: _unused, ...withoutProver } = overrides;
    await run(started, withoutProver);
    return { started, specs };
  }

  it("verifies the proof with the prover binary of the configuration, which sees only the PATH", async () => {
    const { specs } = await runWithProof({ PATH: "/custom/bin", RUNNER_KEY: SIGNER_KEY });
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({ command: "/bin/zk-bridge-prover", args: expect.arrayContaining(["verify", "--program-vkey", PROGRAM_KEY]) });
    expect(specs[0]!.environment).toEqual({ PATH: "/custom/bin" });
  });

  it("gives the prover a default PATH when the environment has none", async () => {
    const { specs } = await runWithProof({ PATH: undefined, RUNNER_KEY: SIGNER_KEY });
    expect(specs[0]!.environment).toEqual({ PATH: "/usr/bin:/bin" });
  });

  it("records the outcome of the update in the outcome file, stamped by the clock it is given", async () => {
    const { started } = await runWithProof({ PATH: "/custom/bin", RUNNER_KEY: SIGNER_KEY });
    const lines = readFileSync(join(started.created.directory, "state", "outcomes-eth-pls.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(lines).toEqual([
      expect.objectContaining({ time: new Date(1_800_000_000_000).toISOString(), kind: "update", status: "skipped", pair: "eth-pls", direction: "first-to-second", startSlot: "100", newSlot: "164" }),
    ]);
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
    const { overrides, client, subscribers } = standardOverrides();
    // The simulation answers (it needs no fee quote); the step after it asks for one.
    Object.assign(client, { call: async () => ({ data: "0x" }), estimateGas: async () => 100_000n });
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
