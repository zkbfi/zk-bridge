import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeFunctionData, encodePacked, keccak256, recoverAddress, sha256, type Address, type Hex } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beaconLightClientAbi, encodeFeeDirector, encodeProofMessage, messageBridgeAbi, multicall3Abi, deliveryRouterAbi } from "@zk-bridge/shared";
import { emptyProverSetup, saveProverSetup, type ProverSetup } from "@zk-bridge/shared/config";
import { createTransactionPort } from "../../src/chain/transactions.ts";
import { loadBotContext } from "../../src/runtime/context.ts";
import { startPublisher } from "../../src/publisher/service.ts";
import { createSerialQueue } from "../../src/runner/serial-queue.ts";
import { createRunner } from "../../src/runner/runner.ts";
import { startRunner } from "../../src/runner/service.ts";
import { createLightClientReader, type ProverBinary } from "@zk-bridge/shared/prover";
import { INITIAL_RUNNER_STATE, type RunnerState } from "../../src/runner/state.ts";
import type { StateStore } from "../../src/runtime/state-file.ts";
import { ANVIL_MNEMONIC, ACCOUNT, account, buildOracleUpdate, compileStackContracts, startStack, type Stack } from "./support/stack.ts";
import { waitFor } from "../../../indexer/test/integration/support/processes";
import { createMnemonicSource } from "../../../terminal/src/signing/mnemonic.ts";
import { evidenceFor, emptyExecuteMessage, fakeIndexer, fakeProver, feeOfferData, feedItem, memoryLogger, memoryOutcomes } from "../support/builders.ts";
import { startFakeBoard, type FakeBoard } from "../../../shared/test/support/fake-board.ts";
import { startFakeIndexer, type FakeIndexer } from "../support/fake-indexer.ts";
import type { SyntheticArtifacts } from "../../../indexer/test/integration/support/chains";

/**
 * The bots against a local chain with the REAL `BeaconLightClient` and the REAL `DeliveryRouter`.
 *
 * Real: both bots with their configuration files, secret references and loops; the contracts named above; signing and
 * sending of transactions; simulation; gas pricing from the chain; the worker thread that grinds proof of work; the
 * socket client of `@msgboard/sdk` with its subscription; the proof message codec; the `zk-bridge-prover verify`
 * command (test 2).
 *
 * Synthetic, and why:
 * - The update. The local chains have no beacon chain, so the public values are asserted, not derived from signed
 *   headers, and the "proof" is an oracle signature in the 356 bytes of a real proof (the verifier double accepts that
 *   shape). `OracleSP1Verifier` of the local stack takes 65 bytes, which does not fit the proof message.
 * - The prover. A script stands in for `zk-bridge-prover prove`, because it needs a beacon node and a graphics processor. It prints the
 *   package of the update above.
 * - Local verification (test 1). The stand-in checks the oracle signature, as `zk-bridge-prover verify` checks Groth16.
 *   Test 2 runs the real command, which refuses the oracle proof.
 * - msgboard. A node in this process speaks the same JSON-RPC and subscription messages, and checks no proof of work.
 * - Delivery. The stub mediator releases tokens to the real router when it gets a proof whose anchor slot is 4242. The
 *   evidence is made up. The fee maths, the payout to the runner and the recipient, and the gas are the real router's.
 */

const REPOSITORY = new URL("../../../../", import.meta.url).pathname;
const REAL_PROVER = join(REPOSITORY, "prover/target/release/zk-bridge-prover");
const FAKE_PROVER = new URL("../support/fake-prover.mjs", import.meta.url).pathname;

// Made-up values with the real shapes. None is a live key.
const RUNPOD_KEY = "rpa_TESTONLY1234567890abcdefghijkl";
const VALVE_KEY = "vk_TESTONLY0987654321zyxwvu";

const toolsPresent = (() => {
  try {
    execFileSync("anvil", ["--version"], { stdio: "ignore" });
    execFileSync("forge", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const scratch: string[] = [];
let artifacts: SyntheticArtifacts;
let stack: Stack;

beforeAll(async () => {
  if (!toolsPresent) return;
  artifacts = compileStackContracts();
  stack = await startStack(artifacts);
});
afterAll(async () => {
  await stack?.anvil.stop();
  await Promise.all(scratch.map((path) => rm(path, { recursive: true, force: true })));
});

const head = () => stack.chain.publicClient.readContract({ address: stack.lightClient, abi: beaconLightClientAbi, functionName: "head" }) as Promise<bigint>;

interface BotFiles {
  readonly configPath: string;
  readonly stateDirectory: string;
  readonly environment: Record<string, string>;
}

/** Writes the setup file, the deployment file and the bot configuration for one bot pair, the way an operator would. */
async function writeBotFiles(options: { name: string; boardUrl: string; indexerUrl: string; proverBinary: string; policy?: ProverSetup["policy"]; deliveryRouter?: Address }): Promise<BotFiles> {
  const directory = await mkdtemp(join(tmpdir(), `bots-${options.name}-`));
  scratch.push(directory);
  const stateDirectory = join(directory, "state");
  await mkdir(stateDirectory);
  const reference = (variable: string) => ({ source: "environment" as const, variable });
  const setup: ProverSetup = {
    ...emptyProverSetup(),
    endpointUrl: "https://worker.example.org",
    runpodApiKey: reference("RUNPOD_API_KEY"),
    chains: {
      "1": { rpc: reference("DUMMY_RPC_1"), beacon: reference("DUMMY_BEACON_1") },
      "369": { rpc: reference("STACK_RPC_369"), beacon: reference("DUMMY_BEACON_369") },
    },
    msgboardUrl: reference("BOARD_URL"),
    directions: ["first-to-second"],
    policy: options.policy ?? { proveWhenTransferWaits: false, intervalSeconds: 3600 },
  };
  const setupFile = join(directory, "prover-setup.json");
  await saveProverSetup(setupFile, setup);
  const section = (chainId: number, seed: number, real: boolean) => {
    const filler = (offset: number) => `0x${(seed + offset).toString(16).padStart(2, "0").repeat(20)}`;
    return {
      chain_id: chainId,
      bridge: real ? stack.mediatorBridge : filler(1),
      mediator: real ? stack.mediatorBridge : filler(2),
      token_factory: filler(3),
      wrapped_native: real ? stack.wrappedNative : filler(5),
      gate: filler(6),
      light_client: real ? stack.lightClient : filler(7),
      delivery_router: real ? stack.deliveryRouter : null,
      start_block: 0,
    };
  };
  const deploymentFile = join(directory, "deployment.json");
  await writeFile(deploymentFile, JSON.stringify({ chain_a: section(1, 0x10, false), chain_b: section(369, 0x20, true) }));
  const configPath = join(directory, "bots.json");
  await writeFile(
    configPath,
    JSON.stringify({
      schemaVersion: 1,
      setupFile,
      deploymentFile,
      stateDirectory,
      publisher: { prover: { binary: FAKE_PROVER }, pollSeconds: 1, republishSeconds: 600, indexerUrl: options.indexerUrl },
      runner: {
        prover: { binary: options.proverBinary },
        indexerUrl: options.indexerUrl,
        pollSeconds: 1,
        maximumPrerequisiteSpendPerSweepWei: "1000000000000000000",
        maximumPrerequisiteSpendPerDayWei: "10000000000000000000",
        maximumUnrecoveredPrerequisiteLossWei: "1000000000000000000",
        ...(options.deliveryRouter === undefined ? {} : { deliveryRouter: options.deliveryRouter }),
        multicall3: stack.multicall3,
        signer: { kind: "mnemonic", mnemonic: "env:RUNNER_MNEMONIC", index: ACCOUNT.runner },
      },
    }),
  );
  const environment = {
    PATH: process.env.PATH ?? "",
    DUMMY_RPC_1: "http://127.0.0.1:1",
    DUMMY_BEACON_1: "http://127.0.0.1:2",
    DUMMY_BEACON_369: "http://127.0.0.1:3",
    // The key rides in the query, where the redactor looks for it.
    STACK_RPC_369: `${stack.anvil.url}/?key=${VALVE_KEY}`,
    BOARD_URL: options.boardUrl,
    RUNPOD_API_KEY: RUNPOD_KEY,
    RUNNER_MNEMONIC: ANVIL_MNEMONIC,
  };
  return { configPath, stateDirectory, environment };
}

/** The package that the stand-in prover prints for an update. */
function packageFor(update: Awaited<ReturnType<typeof buildOracleUpdate>>): string {
  return JSON.stringify({
    schemaVersion: 1,
    route: "ethereum_to_pulsechain",
    programKey: stack.programKey,
    startHeadSlot: Number(update.startSlot),
    startHeadRoot: update.startRoot,
    newHeadSlot: Number(update.newSlot),
    newHeadRoot: update.newRoot,
    latestFinalizedSlot: Number(update.newSlot),
    publicValues: update.publicValues,
    proof: update.proof,
    updateCalldata: "0x",
    backend: "remote",
    destination: { chainId: 369, lightClient: stack.lightClient },
    createdAt: "2026-10-25T00:00:00Z",
  });
}

async function scriptTheProver(files: BotFiles, update: Awaited<ReturnType<typeof buildOracleUpdate>>): Promise<void> {
  await writeFile(
    join(files.stateDirectory, "scenario.json"),
    JSON.stringify({ logPath: join(files.stateDirectory, "prover-runs.jsonl"), keyVariable: "RUNPOD_API_KEY", exitCode: 0, stdout: packageFor(update) }),
  );
}

/** Stands in for `zk-bridge-prover verify`: the proof must carry the oracle signature over the digest. */
const oracleVerification: ProverBinary = {
  async prove() {
    throw new Error("the runner does not prove");
  },
  async evidence() {
    throw new Error("no evidence in this test");
  },
  async verify({ programKey, publicValues, proof }) {
    const digest = keccak256(encodePacked(["bytes32", "bytes32"], [programKey, sha256(publicValues)]));
    const signer = await recoverAddress({ hash: digest, signature: `0x${proof.slice(10, 10 + 130)}` });
    if (signer !== account(ACCOUNT.oracle).address) throw new Error("the proof is not signed by the oracle");
  },
};

describe.skipIf(!toolsPresent)("the proof path on a local stack", () => {
  let board: FakeBoard;
  let indexer: FakeIndexer;
  beforeAll(async () => {
    indexer = await startFakeIndexer();
  });
  afterAll(async () => {
    await board?.stop();
    await indexer?.stop();
  });

  it("publisher to board to runner: the proof is posted, the runner posts update, and the publisher stops", async () => {
    board = await startFakeBoard();
    const files = await writeBotFiles({ name: "proof", boardUrl: board.url, indexerUrl: indexer.url, proverBinary: REAL_PROVER });
    const startHead = await head();
    expect(startHead).toBe(100n);
    const update = await buildOracleUpdate(stack, 164n);
    await scriptTheProver(files, update);

    const runnerLines: string[] = [];
    const runnerContext = await loadBotContext({ configPath: files.configPath, environment: files.environment, write: (line) => runnerLines.push(line) });
    const controller = new AbortController();
    const runnerDone = startRunner({ context: runnerContext, signal: controller.signal, runOnce: false, overrides: { prover: () => oracleVerification } });
    await waitFor("the runner subscription", async () => (runnerLines.some((line) => line.includes('"board_subscribed"')) ? true : undefined));

    const publisherLines: string[] = [];
    const publisherContext = await loadBotContext({ configPath: files.configPath, environment: files.environment, write: (line) => publisherLines.push(line) });
    await startPublisher({ context: publisherContext, signal: new AbortController().signal, runOnce: true });
    expect(board.messages).toHaveLength(1);
    expect(publisherLines.some((line) => line.includes('"proof_posted"'))).toBe(true);

    await waitFor("the head to move", async () => ((await head()) === 164n ? true : undefined), 90_000);

    // One update, although the runner saw the message by subscription and by the board listing.
    const updates = await stack.chain.publicClient.getContractEvents({ address: stack.lightClient, abi: beaconLightClientAbi, eventName: "HeadUpdated", fromBlock: 0n });
    expect(updates).toHaveLength(1);
    expect(updates[0]?.args.slot).toBe(164n);
    // The runner writes the outcome after the receipt, so the head can move a moment before the file exists.
    const outcomesPath = join(files.stateDirectory, "outcomes-eth-pls.jsonl");
    await waitFor("the outcome of the update", async () => (existsSync(outcomesPath) ? true : undefined));
    const outcomes = readFileSync(outcomesPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(outcomes).toEqual([expect.objectContaining({ kind: "update", status: "posted", startSlot: "100", newSlot: "164" })]);

    // The publisher sees the head at the end of its proof and posts nothing more, even when the republish time has come.
    await writeFile(join(files.stateDirectory, "scenario.json"), JSON.stringify({ logPath: join(files.stateDirectory, "prover-runs.jsonl"), keyVariable: "RUNPOD_API_KEY", exitCode: 3 }));
    await startPublisher({ context: publisherContext, signal: new AbortController().signal, runOnce: true, overrides: { now: () => Date.now() + 3 * 3600 * 1000 } });
    expect(board.messages).toHaveLength(1);
    expect(publisherLines.some((line) => line.includes('"proof_dropped"') && line.includes('"covered"'))).toBe(true);

    controller.abort();
    await runnerDone;

    // No log line of either bot holds a key, and the RunPod key reached the prover only through its environment.
    for (const line of [...runnerLines, ...publisherLines]) {
      expect(line).not.toContain(VALVE_KEY);
      expect(line).not.toContain(RUNPOD_KEY);
    }
    const proverRuns = readFileSync(join(files.stateDirectory, "prover-runs.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(proverRuns[0].keyInEnvironment).toBe(RUNPOD_KEY);
    expect(proverRuns[0].args.join(" ")).not.toContain(RUNPOD_KEY);
  });

  it("reads the reward address from the router at start up, and logs it", async () => {
    await board?.stop();
    board = await startFakeBoard();
    const files = await writeBotFiles({ name: "reads-reward", boardUrl: board.url, indexerUrl: indexer.url, proverBinary: FAKE_PROVER });
    const lines: string[] = [];
    const context = await loadBotContext({ configPath: files.configPath, environment: files.environment, write: (line) => lines.push(line) });
    await startRunner({ context, signal: new AbortController().signal, runOnce: true });
    const started = lines.map((line) => JSON.parse(line) as Record<string, unknown>).find((line) => line.event === "runner_started");
    // The configuration names no reward address. The value comes from `rewardAddress()` of the deployed router.
    expect(started).toMatchObject({ deliveryRouter: stack.deliveryRouter, rewardAddress: account(ACCOUNT.reward).address });
  });

  it("stops the start with an error that names the router and the chain when the router has no reward address to read, and sends nothing", async () => {
    await board?.stop();
    board = await startFakeBoard();
    const nonceBefore = await stack.chain.publicClient.getTransactionCount({ address: account(ACCOUNT.runner).address });
    // Multicall3 has no `rewardAddress()`, so the read reverts.
    const files = await writeBotFiles({ name: "no-reward", boardUrl: board.url, indexerUrl: indexer.url, proverBinary: FAKE_PROVER, deliveryRouter: stack.multicall3 });
    const context = await loadBotContext({ configPath: files.configPath, environment: files.environment, write: () => undefined });
    await expect(startRunner({ context, signal: new AbortController().signal, runOnce: true })).rejects.toThrow(
      new RegExp(`Cannot read rewardAddress\\(\\) of the delivery router ${stack.multicall3} on `),
    );
    expect(await stack.chain.publicClient.getTransactionCount({ address: account(ACCOUNT.runner).address })).toBe(nonceBefore);
  });

  it.skipIf(!existsSync(REAL_PROVER))("the real `zk-bridge-prover verify` refuses the oracle proof, and the chain stays where it is", async () => {
    await board?.stop();
    board = await startFakeBoard();
    const files = await writeBotFiles({ name: "refusal", boardUrl: board.url, indexerUrl: indexer.url, proverBinary: REAL_PROVER });
    const before = await head();
    const update = await buildOracleUpdate(stack, before + 36n);
    await scriptTheProver(files, update);
    const publisherContext = await loadBotContext({ configPath: files.configPath, environment: files.environment, write: () => undefined });
    await startPublisher({ context: publisherContext, signal: new AbortController().signal, runOnce: true });
    expect(board.messages).toHaveLength(1);

    const lines: string[] = [];
    const runnerContext = await loadBotContext({ configPath: files.configPath, environment: files.environment, write: (line) => lines.push(line) });
    await startRunner({ context: runnerContext, signal: new AbortController().signal, runOnce: true });
    expect(lines.some((line) => line.includes('"proof_forgery_refused"'))).toBe(true);
    expect(await head()).toBe(before);
  });
});

describe.skipIf(!toolsPresent)("delivery through the real delivery router", () => {
  const recipient = () => account(ACCOUNT.recipient).address;
  const value = 5n * 10n ** 18n;
  const abiOf = (name: string) => artifacts[name]?.abi as never;
  const balanceOf = (holder: Address) => stack.chain.publicClient.readContract({ address: stack.token, abi: abiOf("MockERC20"), functionName: "balanceOf", args: [holder] }) as Promise<bigint>;

  const director = (fields: { settings: bigint; limit: bigint; multiplier: bigint }) => ({ recipient: recipient(), ...fields });
  /**
   * The callback data of an offer, from the shared encoder. The context names the fee token as the wrapped native token,
   * so the guard accepts every setting: one test offers an unwrap request on a plain token, as a hand written relay could.
   */
  const callbackOf = (fields: { settings: bigint; limit: bigint; multiplier: bigint }) =>
    encodeFeeDirector(director(fields), { router: stack.deliveryRouter, protectedAddresses: [], destinationToken: stack.token, destinationWrappedNative: stack.token });

  async function makeRunner(items: ReturnType<typeof feedItem>[], offers: Record<string, Hex>, overrides: { tokenValuationsWei?: Record<string, bigint> } = {}) {
    const signer = await createMnemonicSource({ mnemonic: ANVIL_MNEMONIC }).openSigner(`m/44'/60'/0'/0/${ACCOUNT.runner}`);
    const chain = createTransactionPort({ client: stack.chain.publicClient, signer, chainId: 369, receiptTimeoutMilliseconds: 60_000 });
    const prover = fakeProver({ evidence: () => evidenceFor({ executeData: emptyExecuteMessage(4242n) }) });
    const { logger } = memoryLogger();
    const outcomes = memoryOutcomes();
    const state: StateStore<RunnerState> = { async load() { return INITIAL_RUNNER_STATE; }, async update(mutate) { return mutate(INITIAL_RUNNER_STATE); } };
    const runner = createRunner({
      pairName: "eth-pls",
      direction: "first-to-second",
      sourceChainId: 1,
      destinationChainId: 369,
      lightClientAddress: stack.lightClient,
      lightClient: createLightClientReader(stack.chain.publicClient, stack.lightClient),
      delivery: {
        direction: "first-to-second",
        sourceChainId: 1,
        chain,
        prover,
        indexer: fakeIndexer(items, offers),
        source: { findMessageLogIndex: async () => 0 },
        deliveryRouter: stack.deliveryRouter,
        multicall: stack.multicall3,
        rewardAddress: account(ACCOUNT.reward).address,
        wrappedNative: stack.wrappedNative,
        bridge: stack.mediatorBridge,
        tokenFactory: null,
        settings: {
          maximumLossPercent: 20,
          deliverWithoutOffer: false,
          // One whole fee token is worth one whole native coin.
          tokenValuationsWei: overrides.tokenValuationsWei ?? { [stack.token.toLowerCase()]: 10n ** 18n },
          proofCheckGas: 400_000n,
          maximumPrerequisiteRounds: 2,
          prerequisiteGasFallback: 300_000n,
          maximumPrerequisiteSpendPerSweepWei: 10n ** 24n,
          maximumPrerequisiteSpendPerDayWei: 10n ** 24n,
          maximumUnrecoveredPrerequisiteLossWei: 10n ** 24n,
          maximumBatchSize: 5,
          maximumBatchGas: 6_000_000n,
        },
        logger,
      },
      state,
      outcomes,
      queue: createSerialQueue(),
      now: Date.now,
      maximumDeliveriesPerSweep: 5,
      prerequisiteLossRefusalMilliseconds: 1_800_000,
      logger,
    });
    return { runner, outcomes, prover, signer };
  }

  /** Arms the stub bridge. `id` names the message that the bridge reports as executed: the oldest item of the batch, which the runner sends first. */
  const arm = (data: Hex, id: number) => stack.chain.send(stack.mediatorBridge, "StubMediatorBridge", "arm", [stack.deliveryRouter, stack.token, value, data, item(id).messageId], ACCOUNT.deployer);
  const item = (id: number) => feedItem({ id, token: stack.token });
  const offerData = (fields: { settings: bigint; limit: bigint; multiplier: bigint }) => feeOfferData({ director: director(fields), value, token: stack.token, recipient: stack.deliveryRouter });

  it("delivers a message whose gas based fee pays, and the router pays the runner and the recipient", async () => {
    const offer = { settings: 0n, limit: 10n ** 18n, multiplier: 3n * 10n ** 18n };
    const callback = callbackOf(offer);
    await arm(callback, 1);
    const first = item(1);
    const { runner, outcomes, signer } = await makeRunner([first], { [first.messageId]: offerData(offer) });
    const reward = account(ACCOUNT.reward).address;
    const before = { runner: await balanceOf(signer.address), reward: await balanceOf(reward), recipient: await balanceOf(recipient()) };

    expect(await runner.sweep()).toMatchObject({ delivered: 1, skipped: 0, failed: 0 });

    const outcome = outcomes.records[0] as Record<string, unknown>;
    expect(outcome).toMatchObject({ kind: "delivery", status: "delivered", path: "delivery-router" });
    const feeReceived = outcome.feeReceivedTokens as bigint;
    expect(feeReceived).toBeGreaterThan(0n);
    // The fee goes to the reward address. The signer is a hot key that only pays gas, and it receives no token.
    expect(await balanceOf(reward)).toBe(before.reward + feeReceived);
    expect(await balanceOf(signer.address)).toBe(before.runner);
    // The recipient gets the value less the fee. The router keeps nothing.
    expect(await balanceOf(recipient())).toBe(before.recipient + value - feeReceived);
    expect(await balanceOf(stack.deliveryRouter)).toBe(0n);
    // The fee covered the cost: that is what the runner decided on.
    expect(feeReceived).toBeGreaterThanOrEqual(outcome.gasCostWei as bigint);
    console.info(`gas used by executeMessage on the stack: ${outcome.gasUsed}; fee in tokens: ${feeReceived}; cost in wei: ${outcome.gasCostWei}`);
  });

  it("skips a message whose fee is far below the gas cost, and sends no transaction", async () => {
    const offer = { settings: 1n, limit: 1_000_000_000n, multiplier: 0n }; // a fixed fee of 1e9 wei
    const callback = callbackOf(offer);
    await arm(callback, 2);
    const stingy = item(2);
    const { runner, outcomes, prover, signer } = await makeRunner([stingy], { [stingy.messageId]: offerData(offer) });
    const nonce = await stack.chain.publicClient.getTransactionCount({ address: signer.address });

    expect(await runner.sweep()).toMatchObject({ delivered: 0, skipped: 1 });
    expect(outcomes.records[0]).toMatchObject({ status: "skipped", reason: "loss-at-or-above-limit" });
    expect((prover as { evidenceRuns: number }).evidenceRuns).toBe(0);
    expect(await stack.chain.publicClient.getTransactionCount({ address: signer.address })).toBe(nonce);
  });

  it("skips a message that the bridge already delivered: the simulation shows it, and nothing is sent", async () => {
    // The previous test left the stub armed and delivered by the first test: running it again reverts.
    const offer = { settings: 0n, limit: 10n ** 18n, multiplier: 3n * 10n ** 18n };
    const callback = callbackOf(offer);
    await arm(callback, 3);
    // Deliver it once outside the runner, then let the runner try.
    const direct = item(3);
    const first = await makeRunner([direct], { [direct.messageId]: offerData(offer) });
    expect(await first.runner.sweep()).toMatchObject({ delivered: 1 });
    const again = item(4);
    const second = await makeRunner([again], { [again.messageId]: offerData(offer) });
    const nonce = await stack.chain.publicClient.getTransactionCount({ address: second.signer.address });

    expect(await second.runner.sweep()).toMatchObject({ delivered: 0, skipped: 1 });
    // The router reads the AlreadyDelivered refusal of the bridge as a skip, so the item is final.
    expect(second.outcomes.records[0]).toMatchObject({ status: "skipped", reason: "already-delivered" });
    expect(await stack.chain.publicClient.getTransactionCount({ address: second.signer.address })).toBe(nonce);
  });
  it("carries the light client update and the message in ONE transaction, and the fee goes to the reward address", async () => {
    const offer = { settings: 0n, limit: 10n ** 18n, multiplier: 3n * 10n ** 18n };
    await arm(callbackOf(offer), 5);
    const only = item(5);
    const { runner, outcomes, signer } = await makeRunner([only], { [only.messageId]: offerData(offer) });
    const headBefore = await head();
    const update = await buildOracleUpdate(stack, headBefore + 36n);
    const payload = encodeProofMessage({ version: 1, pair: "eth-pls", direction: "first-to-second", programKey: stack.programKey, ...update });
    const nonceBefore = await stack.chain.publicClient.getTransactionCount({ address: signer.address });

    const handling = await runner.handleProofPayload(payload);

    expect(handling.handled).toBe("update-posted");
    expect(await head()).toBe(update.newSlot);
    // One transaction did both: the update and the delivery.
    expect(await stack.chain.publicClient.getTransactionCount({ address: signer.address })).toBe(nonceBefore + 1);
    expect(outcomes.records.find((record) => record.kind === "update")).toMatchObject({ status: "posted", newSlot: update.newSlot });
    expect(outcomes.records.find((record) => record.kind === "delivery")).toMatchObject({ status: "delivered", path: "delivery-router" });
  });

  it("drops the item that the bridge already delivered from a batch, and still sends the batch of the others in one transaction", async () => {
    const offer = { settings: 0n, limit: 10n ** 18n, multiplier: 3n * 10n ** 18n };
    await arm(callbackOf(offer), 7);
    // The stub holds one armed message. Two items carry its proof: the second one reverts with AlreadyDelivered once the first ran.
    const first = item(6);
    const second = item(7);
    const { runner, outcomes, signer } = await makeRunner([first, second], { [first.messageId]: offerData(offer), [second.messageId]: offerData(offer) });
    const nonceBefore = await stack.chain.publicClient.getTransactionCount({ address: signer.address });

    expect(await runner.sweep()).toMatchObject({ delivered: 1, skipped: 1 });

    expect(await stack.chain.publicClient.getTransactionCount({ address: signer.address })).toBe(nonceBefore + 1);
    expect(outcomes.records.map((record) => (record.status === "skipped" ? record.reason : record.status)).sort()).toEqual(["already-delivered", "delivered"]);
  });
  it("delivers through executeMessage of the router: the batch holds the call with the proof only, and the signer is not named anywhere", async () => {
    const offer = { settings: 1n, limit: 10n ** 17n, multiplier: 0n };
    await arm(callbackOf(offer), 8);
    const only = item(8);
    const { runner, outcomes, signer } = await makeRunner([only], { [only.messageId]: offerData(offer) });
    expect(await runner.sweep()).toMatchObject({ delivered: 1 });
    const transactionHash = (outcomes.records[0] as Record<string, unknown>).transactionHash as Hex;
    const sent = await stack.chain.publicClient.getTransaction({ hash: transactionHash });
    expect(sent.from.toLowerCase()).toBe(signer.address.toLowerCase());
    expect(sent.input.toLowerCase()).not.toContain(signer.address.slice(2).toLowerCase());
    expect(sent.to?.toLowerCase()).toBe(stack.multicall3.toLowerCase());
    const batch = decodeFunctionData({ abi: multicall3Abi, data: sent.input });
    if (batch.functionName !== "aggregate3") throw new Error(`${batch.functionName} is no batch`);
    const [call] = batch.args[0];
    expect(call?.target.toLowerCase()).toBe(stack.deliveryRouter.toLowerCase());
    expect(call?.allowFailure).toBe(true);
    const inner = decodeFunctionData({ abi: deliveryRouterAbi, data: (call as { callData: Hex }).callData });
    expect(inner.functionName).toBe("executeMessage");
    expect(inner.args).toHaveLength(1);
  });

  it("pays the tip to the reward address when another account sends a copy of the delivery, so the copy gains nothing", async () => {
    const offer = { settings: 1n, limit: 10n ** 17n, multiplier: 0n };
    await arm(callbackOf(offer), 9);
    const reward = account(ACCOUNT.reward).address;
    const copier = account(ACCOUNT.copier).address;
    const before = { reward: await balanceOf(reward), copier: await balanceOf(copier), recipient: await balanceOf(recipient()) };
    const decoded = decodeFunctionData({ abi: messageBridgeAbi, data: emptyExecuteMessage(4242n) });
    if (decoded.functionName !== "executeMessage") throw new Error("the proof is not an executeMessage call");

    await stack.chain.send(stack.deliveryRouter, "DeliveryRouter", "executeMessage", [decoded.args[0]], ACCOUNT.copier);

    expect(await balanceOf(reward)).toBe(before.reward + offer.limit);
    expect(await balanceOf(copier)).toBe(before.copier);
    expect(await balanceOf(recipient())).toBe(before.recipient + value - offer.limit);
    expect(await balanceOf(stack.deliveryRouter)).toBe(0n);
  });

  it("prices an unwrap request on a token that is not the wrapped native token as a token payout: it needs a valuation, and the router pays the plain token", async () => {
    // Settings 2n: gas based fee with the unwrap flag. The fee token is not the wrapped native token.
    const offer = { settings: 2n, limit: 10n ** 18n, multiplier: 3n * 10n ** 18n };
    await arm(callbackOf(offer), 10);
    const unwrap = item(10);
    const { runner, outcomes } = await makeRunner([unwrap], { [unwrap.messageId]: offerData(offer) }, { tokenValuationsWei: {} });
    // With no valuation of the token the runner cannot price the tip. It does not treat the tip as native coin.
    expect(await runner.sweep()).toMatchObject({ delivered: 0, skipped: 1 });
    expect(outcomes.records[0]).toMatchObject({ status: "skipped", reason: "no-price-for-fee-token" });

    const reward = account(ACCOUNT.reward).address;
    const before = { token: await balanceOf(reward), native: await stack.chain.publicClient.getBalance({ address: reward }) };
    const priced = await makeRunner([unwrap], { [unwrap.messageId]: offerData(offer) });
    expect(await priced.runner.sweep()).toMatchObject({ delivered: 1, skipped: 0 });
    const outcome = priced.outcomes.records[0] as Record<string, unknown>;
    expect(outcome.feeReceivedTokens as bigint).toBeGreaterThan(0n);
    expect(await balanceOf(reward)).toBe(before.token + (outcome.feeReceivedTokens as bigint));
    expect(await stack.chain.publicClient.getBalance({ address: reward })).toBe(before.native);
  });
});

