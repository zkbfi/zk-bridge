/**
 * The bots (step 4 of the run): the proof publisher posts a proof on a local msgboard, and the delivery runner delivers
 * a batch through Multicall3: the light client update first, then one `executeMessage` of the delivery router for each
 * message. A second batch, from an account that is not the runner, holds failing calls on purpose.
 */
import { writeFileSync, mkdirSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { decodeErrorResult, decodeEventLog, encodeFunctionData, formatUnits, type Address, type Hex, type TransactionReceipt } from "viem";
import { beaconLightClientAbi, deliveryRouterAbi, messageBridgeAbi, tipVersusCost, type BatchedCall } from "@zk-bridge/shared";
import { ANVIL_MNEMONIC, accountOf, chainOf, sendFrom, type Context } from "../context.ts";
import { execute, readyEvidence, sendBatch, type MessageRecord } from "../delivery.ts";
import { record } from "../results.ts";
import { balanceAt, copyOf, nativeTokens, valuationsWei } from "../tokens.ts";
import { loadMessages, saveMessage } from "../messages.ts";
import { sideOf } from "../terminal.ts";
import { relayWithGate, startServices } from "./transfers.ts";
import { postUpdate } from "./updates.ts";
import { prove } from "../prover.ts";
import { mnemonicToAccount } from "viem/accounts";
import { spawnBackground, stopBackground, waitUntil, type Background } from "../processes.ts";

const WHOLE = 10n ** 18n;

/** The messages of the bot run: three for the runner and three for the batch of the copier. */
const BOT_CASES = [
  // The tip of this one is set at run time from the cost of a delivery (see `coveringTipOf`), so it always covers the cost.
  { name: "bot-default-tip", fee: { delivery: "yes", feeMode: "fixed" }, recipient: "recipient", group: "runner" },
  { name: "bot-percent-tip", fee: { delivery: "yes", feeMode: "percentage", feePercent: "0.1" }, recipient: "recipientTwo", group: "runner" },
  { name: "bot-fixed-tip", fee: { delivery: "yes", feeMode: "fixed", feeFixed: "0.5" }, recipient: "recipientThree", group: "runner" },
  // The tip of one base unit is worth less than the gas of a delivery, so the runner skips these and the copier delivers them.
  { name: "copier-tip-one", fee: { delivery: "yes", feeMode: "fixed", feeFixed: "0.000000000000000001" }, recipient: "recipient", group: "copier" },
  { name: "copier-tip-two", fee: { delivery: "yes", feeMode: "fixed", feeFixed: "0.000000000000000001" }, recipient: "recipientTwo", group: "copier" },
  { name: "copier-tip-three", fee: { delivery: "yes", feeMode: "fixed", feeFixed: "0.000000000000000001" }, recipient: "recipientThree", group: "copier" },
] as const;

const AMOUNT = 100n * WHOLE;

const runnerKey = (): Hex => `0x${Buffer.from(mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: 2 }).getHdKey().privateKey!).toString("hex")}`;

/** The value of one whole token in wei: every token of the run is worth 0.001 coin (see `valuationsWei`). */
const TOKEN_VALUE_WEI = 10n ** 15n;
/**
 * The gas that the costliest delivery of the run may use. The protocol has no maximum, so this is the run's own budget:
 * a first send that deploys a copy, plus a call after the delivery, with room to spare.
 */
export const COSTLIEST_DELIVERY_GAS = 10_000_000n;
/** The tip is this many times the worst delivery cost, so a small move of the gas price cannot put it below cost. */
const TIP_MARGIN = 4n;

/**
 * A fixed tip, in whole tokens, that covers the cost of the most expensive delivery. The cost is the gas that a delivery
 * may use (`COSTLIEST_DELIVERY_GAS`) at the gas price of the destination chain. The shared
 * `tipVersusCost` confirms that the tip is not below cost, so the runner delivers at its loss limit of zero.
 *
 * @param gasPrice The gas price of the destination chain, in wei.
 * @throws Error when the tip still reads as below cost.
 */
export const coveringTipFor = (gasPrice: bigint): string => {
  const costWei = COSTLIEST_DELIVERY_GAS * gasPrice;
  const tipUnits = (costWei * TIP_MARGIN * WHOLE) / TOKEN_VALUE_WEI + 1n;
  const valuedWei = (tipUnits * TOKEN_VALUE_WEI) / WHOLE;
  if (tipVersusCost({ tipWei: valuedWei, costWei }).position === "below-cost") throw new Error(`the computed tip ${valuedWei} is below the cost ${costWei}`);
  return formatUnits(tipUnits, 18);
};

/** The covering tip at the current gas price of the destination chain. */
export const coveringTipOf = async (context: Context): Promise<string> => coveringTipFor(await chainOf(context, "b").publicClient.getGasPrice());

/** The file paths of the bot run. */
export const paths = (context: Context) => ({
  setup: join(context.stateDirectory, "bots-setup.json"),
  config: join(context.stateDirectory, "bots.json"),
  state: join(context.stateDirectory, "bots-state"),
  boardUrl: join(context.stateDirectory, "board.url"),
});

/**
 * Writes the setup file and the bot configuration. Neither holds a secret: each secret is the name of a variable.
 *
 * @param directions The directions of the setup file. The bots stage runs one; the open stage runs the runner in both.
 */
export const writeBotConfiguration = async (context: Context, indexerUrl: string, directions: readonly string[] = ["first-to-second"]): Promise<void> => {
  const file = paths(context);
  mkdirSync(file.state, { recursive: true });
  const envReference = (variable: string) => ({ source: "environment", variable });
  // The publisher follows the backend of the run. The oracle needs no endpoint and no RunPod key.
  const remote = context.backend === "remote";
  writeFileSync(
    file.setup,
    JSON.stringify(
      {
        schemaVersion: 1,
        endpointUrl: remote ? (Bun.env.E2E_RUNPOD_URL ?? "") : "",
        runpodApiKey: remote ? envReference("RUNPOD_API_KEY") : null,
        chains: { "1": { rpc: envReference("E2E_RPC_A"), beacon: envReference("E2E_BEACON_A") }, "369": { rpc: envReference("E2E_RPC_B"), beacon: envReference("E2E_BEACON_B") } },
        msgboardUrl: envReference("E2E_MSGBOARD_URL"),
        pair: "eth-pls",
        directions,
        policy: { proveWhenTransferWaits: true, intervalSeconds: 1 },
      },
      null,
      2,
    ),
  );
  const valuations = await valuationsWei(context);
  const prover = { binary: context.proverBinary, timeoutSeconds: 900 };
  writeFileSync(
    file.config,
    JSON.stringify(
      {
        schemaVersion: 1,
        setupFile: file.setup,
        deploymentFile: join(context.stateDirectory, "deployment.json"),
        stateDirectory: file.state,
        secretStore: { kind: "none" },
        logLevel: "info",
        maximumMessageBytes: 8192,
        publisher: { prover, backend: context.backend, oracleKeyVariable: "ORACLE_KEY", apiKeyVariable: "RUNPOD_API_KEY", remote: { mode: "load-balancing" }, pollSeconds: 5, republishSeconds: 600, retryBackoffSeconds: 20, indexerUrl },
        runner: {
          prover: { ...prover, timeoutSeconds: 600 },
          // Only the oracle run accepts the 65-byte test proof. A remote run never does.
          acceptOracleProof: !remote,
          indexerUrl,
          signer: { kind: "private-key", key: "env:E2E_RUNNER_KEY" },
          pollSeconds: 5,
          maximumLossPercent: 0,
          deliverWithoutOffer: false,
          multicall3: context.run.multicall3,
          tokenValuationsWei: valuations,
          priorityFeeWei: "1",
          maximumBatchSize: 5,
          maximumBatchGas: 6_000_000,
          maximumPrerequisiteSpendPerSweepWei: "50000000000000000",
          maximumPrerequisiteSpendPerDayWei: "200000000000000000",
          maximumUnrecoveredPrerequisiteLossWei: "100000000000000000",
          receiptTimeoutSeconds: 120,
        },
      },
      null,
      2,
    ),
  );
};

/** The environment that the bots read. The RunPod key comes from the environment of this process. */
export const botEnvironment = (context: Context, boardUrl: string): Record<string, string> => ({
  ...(process.env as Record<string, string>),
  E2E_RPC_A: context.a.rpcUrl,
  E2E_RPC_B: context.b.rpcUrl,
  E2E_BEACON_A: `${context.beaconUrl}/a`,
  E2E_BEACON_B: `${context.beaconUrl}/b`,
  E2E_MSGBOARD_URL: boardUrl,
  E2E_RUNNER_KEY: runnerKey(),
});

/** Sends the messages of the bot run through the terminal. The gate is confirmed first. */
const sendBotMessages = async (context: Context): Promise<void> => {
  const services = await startServices(context, Bun.env.E2E_INDEXER_URL ?? "http://127.0.0.1:42069");
  const coveringTip = await coveringTipOf(context);
  const { terminalTokens } = await import("../tokens.ts");
  for (const item of BOT_CASES) {
    const tokens = (await terminalTokens(context)).filter((token) => token.side === "first" || token.isBridgedCopy);
    const live = [];
    for (const token of tokens) {
      const chain = token.side === "first" ? context.a : context.b;
      const code = await chain.publicClient.getCode({ address: token.address });
      if (code !== undefined && code !== "0x") live.push(token);
    }
    const tokenA = nativeTokens(context).find((token) => token.key === "tokenA")!;
    const relay = await relayWithGate(context, services, {
      from: "a",
      role: "senderOne",
      values: { token: `${sideOf("a")}:${tokenA.address}`, amount: "100", receiver: accountOf(item.recipient).address, ...item.fee, ...(item.name === "bot-default-tip" ? { feeFixed: coveringTip } : {}) },
      tokens: live,
      label: item.name,
    });
    saveMessage(context, { name: item.name, from: "a", transactionHash: relay.relayHash, logIndex: relay.messageLogIndex, messageId: relay.messageId });
    record(context, { stage: "bots", name: `sent-${item.name}`, ok: true, data: { sendGas: relay.receipt.gasUsed.toString(), transaction: relay.relayHash } });
  }
};

/** What a batch receipt shows, read from its logs. */
export interface BatchReading {
  readonly headUpdates: number;
  readonly deliveries: number;
}

/** Counts the `HeadUpdated` logs of the light client and the `AffirmationCompleted` logs of the bridge in a receipt. */
export const readBatchReceipt = (receipt: TransactionReceipt, addresses: { readonly lightClient: Address; readonly bridge: Address }): BatchReading => {
  let headUpdates = 0;
  let deliveries = 0;
  for (const log of receipt.logs) {
    try {
      if (log.address.toLowerCase() === addresses.lightClient.toLowerCase() && decodeEventLog({ abi: beaconLightClientAbi, data: log.data, topics: log.topics }).eventName === "HeadUpdated") headUpdates += 1;
      if (log.address.toLowerCase() === addresses.bridge.toLowerCase() && decodeEventLog({ abi: messageBridgeAbi, data: log.data, topics: log.topics }).eventName === "AffirmationCompleted") deliveries += 1;
    } catch {
      // A log of another event of the same contract.
    }
  }
  return { headUpdates, deliveries };
};

/**
 * Runs the bot scenario on the running chains, indexer and board: sends six messages, covers them with one update,
 * starts the runner, lets the publisher post a newer proof, and checks the runner's batch. Then the copier sends a batch
 * with failing calls.
 */
export const runBots = async (context: Context, options: { readonly resume: boolean } = { resume: false }): Promise<void> => {
  const started: Background[] = [];
  try {
    await runBotsWithProcesses(context, options, started);
  } finally {
    // A failed stage must not leave a runner or a board behind: the next run would find a runner on old code.
    await Promise.all(started.map((background) => stopBackground(background)));
  }
};

/** Starts the local msgboard and waits for its URL. */
export const startBoard = async (context: Context, started: Background[]): Promise<string> => {
  const file = paths(context);
  // A URL file of an earlier board names a port that nothing listens on any more.
  rmSync(file.boardUrl, { force: true });
  const board = await spawnBackground(context, "board", ["bun", "run", join(context.repositoryRoot, "explorer/e2e/src/board.ts"), file.boardUrl], process.env as Record<string, string>);
  started.push(board);
  return waitUntil("the board URL", () => (existsSync(file.boardUrl) ? readFileSync(file.boardUrl, "utf8") : undefined), 30_000);
};

/** The command line of a bot of the run. */
export const botCommand = (context: Context, role: string, extra: readonly string[] = []): string[] => ["node", join(context.repositoryRoot, "explorer/bots/bin/zk-bridge-bot.mjs"), role, "--config", paths(context).config, ...extra];

const runBotsWithProcesses = async (context: Context, options: { readonly resume: boolean }, started: Background[]): Promise<void> => {
  const indexerUrl = Bun.env.E2E_INDEXER_URL ?? "http://127.0.0.1:42069";
  const file = paths(context);
  const destination = chainOf(context, "b");
  const failures: string[] = [];

  // 1. The messages. No update covers them yet: the publisher proves one and the runner must apply it itself.
  if (!options.resume) await sendBotMessages(context);
  const wanted = new Set<string>(BOT_CASES.map((item) => item.name));
  const messages = loadMessages(context).filter((message) => wanted.has(message.name));
  const { waitForFinality } = await import("./transfers.ts");
  if (!options.resume) await waitForFinality(context, "a", messages);
  const startingHead = (await chainOf(context, "b").publicClient.readContract({ address: destination.deployment.light_client, abi: beaconLightClientAbi, functionName: "head" })) as bigint;
  record(context, { stage: "bots", name: "starting-head", ok: true, data: { head: startingHead.toString() } });

  // 2. The board, the configuration and the runner. The indexer must list the messages as covered.
  await writeBotConfiguration(context, indexerUrl);
  const boardUrl = await startBoard(context, started);
  const board = started[started.length - 1]!;
  const environment = botEnvironment(context, boardUrl);
  // 3. The publisher proves the newest update (a real proof on RunPod) and posts it on the board. The runner starts after the
  // post: it reads the proof from the board and must send the update itself.
  const publisherStarted = Date.now();
  const publisher = await spawnBackground(context, "publisher", botCommand(context, "publisher", ["--once"]), environment, join(context.repositoryRoot, "explorer/bots"));
  started.push(publisher);
  await publisher.exited;
  record(context, { stage: "bots", name: "publisher-run", ok: publisher.exitCode === 0, data: { exitCode: publisher.exitCode ?? -1, seconds: (Date.now() - publisherStarted) / 1000 } });
  const runner = await spawnBackground(context, "runner", botCommand(context, "runner"), environment, join(context.repositoryRoot, "explorer/bots"));
  started.push(runner);

  // 4. The outcomes of the runner. The runner may split its work into batches as its packing decides, so the stage checks
  // outcomes: one head update from the runner, every tipped message delivered, no untipped message delivered.
  const tipped = messages.filter((message) => message.name.startsWith("bot-"));
  const untipped = messages.filter((message) => message.name.startsWith("copier-"));
  const firstBlock = await destination.publicClient.getBlockNumber();
  await waitUntil(
    "the runner to deliver every tipped message",
    async () => {
      const found = await runnerBatches(context, firstBlock);
      return found.deliveries >= tipped.length ? found : undefined;
    },
    300_000,
  );
  await stopBackground(runner);
  await stopBackground(board);
  const settled = await runnerBatches(context, firstBlock);
  const skips = skippedByRunner(context);
  const copy = await copyOf(context, nativeTokens(context).find((token) => token.key === "tokenA")!);
  const lastBlock = settled.lastBlock;
  const rewardAddress = accountOf("reward").address;
  const rewardChange = (await balanceAt(context, "b", copy, rewardAddress, lastBlock)) - (await balanceAt(context, "b", copy, rewardAddress, firstBlock));
  let recipientTotal = 0n;
  for (const item of BOT_CASES.filter((candidate) => candidate.group === "runner")) {
    const address = accountOf(item.recipient).address;
    recipientTotal += (await balanceAt(context, "b", copy, address, lastBlock)) - (await balanceAt(context, "b", copy, address, firstBlock));
  }
  if (settled.headUpdates !== 1) failures.push(`the runner applied ${settled.headUpdates} head updates, expected exactly 1`);
  if (settled.deliveries !== tipped.length) failures.push(`the runner delivered ${settled.deliveries} messages, expected the ${tipped.length} tipped ones and no others`);
  for (const message of untipped) {
    if (skips.get(message.messageId) !== "loss-at-or-above-limit") failures.push(`${message.name} was not skipped with loss-at-or-above-limit (${skips.get(message.messageId) ?? "no skip logged"})`);
  }
  if (rewardChange <= 0n) failures.push("no tip reached the reward address");
  const expectedTotal = AMOUNT * BigInt(tipped.length);
  if (rewardChange + recipientTotal !== expectedTotal) failures.push(`tip ${rewardChange} plus recipients ${recipientTotal} is not ${expectedTotal}`);
  record(context, {
    stage: "bots",
    name: "runner-outcomes",
    ok: failures.length === 0,
    data: {
      batches: settled.batches,
      headUpdates: settled.headUpdates,
      deliveries: settled.deliveries,
      skippedUntipped: untipped.filter((message) => skips.get(message.messageId) === "loss-at-or-above-limit").length,
      tipsToReward: rewardChange.toString(),
      recipientsTotal: recipientTotal.toString(),
      problems: failures.join("; ") || null,
    },
  });

  // 5. The batch of the copier: it holds a stale update and an already delivered message, and three good deliveries.
  await copierBatch(context, messages.filter((message) => message.name.startsWith("copier-")), messages.find((message) => message.name === "bot-default-tip")!, failures);
  if (failures.length > 0) throw new Error(failures.join("; "));
};

/** The name of the custom error in the return data of a failed call, or its selector when no ABI of the run knows it. */
export const errorNameOf = (returnData: Hex): string => {
  try {
    return decodeErrorResult({ abi: [...beaconLightClientAbi, ...messageBridgeAbi, ...deliveryRouterAbi], data: returnData }).errorName;
  } catch {
    return returnData.slice(0, 10);
  }
};

/** The name of the first call of an `aggregate3` transaction: `update` for a light client call, else `executeMessage`. */
const firstCallSelector = async (input: Hex): Promise<string> => {
  const { decodeFunctionData } = await import("viem");
  const { multicall3Abi } = await import("@zk-bridge/shared");
  const outer = decodeFunctionData({ abi: multicall3Abi, data: input });
  const calls = (outer.args as readonly [readonly { callData: Hex }[]])[0];
  const first = calls[0];
  if (first === undefined) return "empty";
  try {
    return decodeFunctionData({ abi: beaconLightClientAbi, data: first.callData }).functionName;
  } catch {
    return decodeFunctionData({ abi: deliveryRouterAbi, data: first.callData }).functionName;
  }
};

/** What the runner did on the destination chain since a block. */
interface RunnerWork {
  readonly batches: number;
  readonly headUpdates: number;
  readonly deliveries: number;
  readonly lastBlock: bigint;
}

/**
 * Adds up the head updates and deliveries of every transaction that the runner account sent since `fromBlock`. The runner
 * may send the light client update on its own or inside a batch, so the receipts decide, not the shape of the call.
 */
const runnerBatches = async (context: Context, fromBlock: bigint): Promise<RunnerWork> => {
  const destination = chainOf(context, "b");
  const head = await destination.publicClient.getBlockNumber();
  let batches = 0;
  let headUpdates = 0;
  let deliveries = 0;
  let lastBlock = fromBlock;
  for (let number = fromBlock + 1n; number <= head; number += 1n) {
    const block = await destination.publicClient.getBlock({ blockNumber: number, includeTransactions: true });
    for (const transaction of block.transactions) {
      if (transaction.from.toLowerCase() !== accountOf("runner").address.toLowerCase()) continue;
      const receipt = await destination.publicClient.getTransactionReceipt({ hash: transaction.hash });
      const reading = readBatchReceipt(receipt, { lightClient: destination.deployment.light_client, bridge: destination.deployment.bridge });
      batches += 1;
      headUpdates += reading.headUpdates;
      deliveries += reading.deliveries;
      lastBlock = number;
    }
  }
  return { batches, headUpdates, deliveries, lastBlock };
};

/** The last skip reason that the runner logged for each message, read from the log of the runner. */
const skippedByRunner = (context: Context): Map<string, string> => {
  const reasons = new Map<string, string>();
  const logFile = join(context.stateDirectory, "logs", "runner.log");
  if (!existsSync(logFile)) return reasons;
  for (const line of readFileSync(logFile, "utf8").split("\n")) {
    if (!line.includes('"delivery_skipped"')) continue;
    const entry = JSON.parse(line) as { messageId: Hex; reason: string };
    reasons.set(entry.messageId, entry.reason);
  }
  return reasons;
};

/**
 * A Multicall3 batch from the copier account, which is not the runner. Anyone may send it, because the router asks nothing
 * of its caller. It holds, in order: a stale update (the head moved past it: it fails), three good deliveries, and the
 * delivery of a message that the runner delivered already (it fails). The two failures must not stop the three deliveries.
 */
const copierBatch = async (context: Context, fresh: readonly MessageRecord[], delivered: MessageRecord, failures: string[]): Promise<void> => {
  const destination = chainOf(context, "b");
  const calls: BatchedCall[] = [];
  // The stale update is the check that the light client refuses an update behind its head. Without one the check
  // would pass without running, so a missing proof fails the stage.
  const staleProof = findStaleUpdate(context);
  if (staleProof === null) failures.push("no stale update proof was found, so the copier batch cannot check that a stale update fails");
  else calls.push({ target: destination.deployment.light_client, callData: staleProof });
  for (const message of fresh) {
    const evidence = await readyEvidence(context, message, "bots");
    calls.push({ target: destination.deployment.delivery_router, callData: evidence.execute.data });
  }
  // The message that the runner delivered. Its evidence still builds: only the status says delivered.
  const doneEvidence = await buildDeliveredEvidence(context, delivered);
  calls.push({ target: destination.deployment.delivery_router, callData: doneEvidence });
  const { sent, results } = await sendBatch(context, "b", "copier", calls);
  const reading = readBatchReceipt(sent.receipt, { lightClient: destination.deployment.light_client, bridge: destination.deployment.bridge });
  const expectedFailures = (staleProof === null ? 0 : 1) + 1;
  const failed = results.filter((result) => !result.success).length;
  const succeeded = results.filter((result) => result.success).length;
  const problems: string[] = [];
  if (reading.deliveries !== fresh.length) problems.push(`the batch delivered ${reading.deliveries} messages, expected ${fresh.length}`);
  if (failed !== expectedFailures) problems.push(`${failed} calls failed, expected ${expectedFailures}`);
  if (staleProof !== null && results[0]?.success !== false) problems.push("the stale update did not fail");
  const last = results.at(-1);
  // The last call repeats a delivery. The bridge must refuse it by name, not by a bare revert.
  if (last === undefined || last.success || errorNameOf(last.returnData) !== "AlreadyDelivered") problems.push(`the repeated delivery did not fail with AlreadyDelivered (${last === undefined ? "no result" : errorNameOf(last.returnData)})`);
  if (reading.headUpdates !== 0) problems.push("a stale update was applied");
  failures.push(...problems);
  record(context, {
    stage: "bots",
    name: "copier-batch",
    ok: problems.length === 0,
    data: {
      transaction: sent.hash,
      sender: accountOf("copier").address,
      calls: calls.length,
      succeeded,
      failed,
      failedCalls: results.filter((result) => !result.success).map((result) => `${result.position}:${errorNameOf(result.returnData)}`).join(","),
      deliveries: reading.deliveries,
      gasUsed: sent.gasUsed.toString(),
      problems: problems.join("; ") || null,
    },
  });
};

/** The calldata of an update that is stale: a proof package that the run saved, for a head that has moved on. */
const findStaleUpdate = (context: Context): Hex | null => {
  const { readdirSync } = require("node:fs") as typeof import("node:fs");
  const files = readdirSync(context.stateDirectory).filter((name) => name.startsWith("proof-a_to_b-") && name.endsWith(".json")).sort();
  const oldest = files[0];
  if (oldest === undefined) return null;
  return (JSON.parse(readFileSync(join(context.stateDirectory, oldest), "utf8")) as { updateCalldata: Hex }).updateCalldata;
};

/** Evidence for a message that is delivered already: the prover builds it, and the status says so. */
const buildDeliveredEvidence = async (context: Context, message: MessageRecord): Promise<Hex> => {
  const { evidence } = await import("../prover.ts");
  const result = await evidence(context, { route: "a_to_b", transactionHash: message.transactionHash, logIndex: message.logIndex });
  if (!result.alreadyDelivered) throw new Error(`${message.name} is not delivered yet`);
  return result.execute.data;
};

export { encodeFunctionData, execute, prove, sendFrom };
