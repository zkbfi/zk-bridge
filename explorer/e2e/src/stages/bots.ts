/**
 * The bots (step 4 of the run): the proof publisher posts a proof on a local msgboard, and the delivery runner delivers
 * a batch through Multicall3: the light client update first, then one `executeMessage` of the delivery router for each
 * message. A second batch, from an account that is not the runner, holds failing calls on purpose.
 */
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { decodeErrorResult, decodeEventLog, encodeFunctionData, type Address, type Hex, type TransactionReceipt } from "viem";
import { beaconLightClientAbi, deliveryRouterAbi, messageBridgeAbi, type BatchedCall } from "@zk-bridge/shared";
import { ANVIL_MNEMONIC, accountOf, chainOf, sendFrom, type Context } from "../context.ts";
import { execute, readyEvidence, sendBatch, type MessageRecord } from "../delivery.ts";
import { record } from "../results.ts";
import { balanceChange } from "../tokens.ts";
import { copyOf, nativeTokens, valuationsWei } from "../tokens.ts";
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
  { name: "bot-default-tip", fee: { delivery: "yes" }, recipient: "recipient", group: "runner" },
  { name: "bot-percent-tip", fee: { delivery: "yes", feeMode: "percentage", feePercent: "0.1" }, recipient: "recipientTwo", group: "runner" },
  { name: "bot-fixed-tip", fee: { delivery: "yes", feeMode: "fixed", feeFixed: "0.5" }, recipient: "recipientThree", group: "runner" },
  // The tip of one base unit is worth less than the gas of a delivery, so the runner skips these and the copier delivers them.
  { name: "copier-tip-one", fee: { delivery: "yes", feeMode: "fixed", feeFixed: "0.000000000000000001" }, recipient: "recipient", group: "copier" },
  { name: "copier-tip-two", fee: { delivery: "yes", feeMode: "fixed", feeFixed: "0.000000000000000001" }, recipient: "recipientTwo", group: "copier" },
  { name: "copier-tip-three", fee: { delivery: "yes", feeMode: "fixed", feeFixed: "0.000000000000000001" }, recipient: "recipientThree", group: "copier" },
] as const;

const AMOUNT = 100n * WHOLE;

const runnerKey = (): Hex => `0x${Buffer.from(mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: 2 }).getHdKey().privateKey!).toString("hex")}`;

/** The file paths of the bot run. */
const paths = (context: Context) => ({
  setup: join(context.stateDirectory, "bots-setup.json"),
  config: join(context.stateDirectory, "bots.json"),
  state: join(context.stateDirectory, "bots-state"),
  boardUrl: join(context.stateDirectory, "board.url"),
});

/** Writes the setup file and the bot configuration. Neither holds a secret: each secret is the name of a variable. */
export const writeBotConfiguration = async (context: Context, indexerUrl: string): Promise<void> => {
  const file = paths(context);
  mkdirSync(file.state, { recursive: true });
  const envReference = (variable: string) => ({ source: "environment", variable });
  writeFileSync(
    file.setup,
    JSON.stringify(
      {
        schemaVersion: 1,
        endpointUrl: Bun.env.E2E_RUNPOD_URL ?? "",
        runpodApiKey: envReference("RUNPOD_API_KEY"),
        chains: { "1": { rpc: envReference("E2E_RPC_A"), beacon: envReference("E2E_BEACON_A") }, "369": { rpc: envReference("E2E_RPC_B"), beacon: envReference("E2E_BEACON_B") } },
        msgboardUrl: envReference("E2E_MSGBOARD_URL"),
        pair: "eth-pls",
        directions: ["first-to-second"],
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
        publisher: { prover, apiKeyVariable: "RUNPOD_API_KEY", remote: { mode: "load-balancing" }, pollSeconds: 5, republishSeconds: 600, retryBackoffSeconds: 20, indexerUrl },
        runner: {
          prover: { ...prover, timeoutSeconds: 600 },
          indexerUrl,
          signer: { kind: "private-key", key: "env:E2E_RUNNER_KEY" },
          pollSeconds: 5,
          minimumMarginWei: "0",
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
const botEnvironment = (context: Context, boardUrl: string): Record<string, string> => ({
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
  const { terminalTokens } = await import("../tokens.ts");
  for (const item of BOT_CASES) {
    const tokens = (await terminalTokens(context)).filter((token) => token.side === "first" || token.symbol.startsWith("zkb"));
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
      values: { token: `${sideOf("a")}:${tokenA.address}`, amount: "100", receiver: accountOf(item.recipient).address, ...item.fee },
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

const runBotsWithProcesses = async (context: Context, options: { readonly resume: boolean }, started: Background[]): Promise<void> => {
  const indexerUrl = Bun.env.E2E_INDEXER_URL ?? "http://127.0.0.1:42069";
  const file = paths(context);
  const destination = chainOf(context, "b");
  const failures: string[] = [];

  // 1. The messages, and the update that covers them. The newer proof for the batch comes from the publisher.
  if (!options.resume) await sendBotMessages(context);
  const wanted = new Set<string>(BOT_CASES.map((item) => item.name));
  const messages = loadMessages(context).filter((message) => wanted.has(message.name));
  const { waitForFinality } = await import("./transfers.ts");
  if (!options.resume) {
    await waitForFinality(context, "a", messages);
    await postUpdate(context, "a", "bots");
  }
  const coveringHead = (await chainOf(context, "b").publicClient.readContract({ address: destination.deployment.light_client, abi: beaconLightClientAbi, functionName: "head" })) as bigint;
  record(context, { stage: "bots", name: "covering-update", ok: true, data: { head: coveringHead.toString() } });

  // 2. The board, the configuration and the runner. The indexer must list the messages as covered.
  await writeBotConfiguration(context, indexerUrl);
  const board = await spawnBackground(context, "board", ["bun", "run", join(context.repositoryRoot, "explorer/e2e/src/board.ts"), file.boardUrl], process.env as Record<string, string>);
  started.push(board);
  const boardUrl = await waitUntil("the board URL", () => (existsSync(file.boardUrl) ? readFileSync(file.boardUrl, "utf8") : undefined), 30_000);
  const environment = botEnvironment(context, boardUrl);
  await waitUntil("the indexer to list the bot messages as covered", async () => {
    const answer = (await (await fetch(`${indexerUrl}/api/feed?direction=1-369&status=covered&limit=50`)).json()) as { items: { messageId: Hex }[] };
    return messages.filter((message) => message.name.startsWith("bot-")).every((message) => answer.items.some((item) => item.messageId === message.messageId)) ? true : undefined;
  }, 180_000);
  const botCommand = (role: string, extra: string[] = []) => ["node", join(context.repositoryRoot, "explorer/bots/bin/zk-bridge-bot.mjs"), role, "--config", file.config, ...extra];
  // 3. The publisher proves the newest update (a real proof on RunPod) and posts it on the board. The runner starts after the
  // post: it reads the proof from the board at its first pass, so the next batch carries the update first.
  const publisherStarted = Date.now();
  const publisher = await spawnBackground(context, "publisher", botCommand("publisher", ["--once"]), environment, join(context.repositoryRoot, "explorer/bots"));
  started.push(publisher);
  await publisher.exited;
  record(context, { stage: "bots", name: "publisher-run", ok: publisher.exitCode === 0, data: { exitCode: publisher.exitCode ?? -1, seconds: (Date.now() - publisherStarted) / 1000 } });
  const runner = await spawnBackground(context, "runner", botCommand("runner"), environment, join(context.repositoryRoot, "explorer/bots"));
  started.push(runner);

  // 4. The batch of the runner: find the aggregate3 transaction on the destination chain.
  const batch = await waitUntil(
    "the runner to send its batch",
    async () => {
      const head = await destination.publicClient.getBlockNumber();
      for (let number = head; number > 0n && number > head - 60n; number -= 1n) {
        const block = await destination.publicClient.getBlock({ blockNumber: number, includeTransactions: true });
        const hit = block.transactions.find((transaction) => transaction.to?.toLowerCase() === context.run.multicall3.toLowerCase() && transaction.from.toLowerCase() === accountOf("runner").address.toLowerCase());
        if (hit !== undefined) return hit;
      }
      return undefined;
    },
    240_000,
  );
  await stopBackground(runner);
  await stopBackground(board);
  const receipt = await destination.publicClient.getTransactionReceipt({ hash: batch.hash });
  const reading = readBatchReceipt(receipt, { lightClient: destination.deployment.light_client, bridge: destination.deployment.bridge });
  const first = await firstCallSelector(batch.input);
  const reward = accountOf("reward").address;
  const copy = await copyOf(context, nativeTokens(context).find((token) => token.key === "tokenA")!);
  const rewardChange = await balanceChange(context, "b", copy, reward, receipt.blockNumber);
  const recipientChanges: Record<string, string> = {};
  for (const item of BOT_CASES.filter((candidate) => candidate.group === "runner")) {
    recipientChanges[item.name] = (await balanceChange(context, "b", copy, accountOf(item.recipient).address, receipt.blockNumber)).toString();
  }
  const delivered = reading.deliveries;
  const expectedTotal = AMOUNT * BigInt(delivered);
  const recipientTotal = Object.values(recipientChanges).reduce((total, value) => total + BigInt(value), 0n);
  if (reading.headUpdates !== 1) failures.push(`the batch applied ${reading.headUpdates} head updates, expected 1`);
  if (first !== "update") failures.push(`the first call of the batch is ${first}, expected update`);
  if (delivered < 3) failures.push(`the batch delivered ${delivered} messages, expected 3`);
  if (rewardChange <= 0n) failures.push("no tip reached the reward address");
  if (rewardChange + recipientTotal !== expectedTotal) failures.push(`tip ${rewardChange} plus recipients ${recipientTotal} is not ${expectedTotal}`);
  record(context, {
    stage: "bots",
    name: "runner-batch",
    ok: failures.length === 0,
    data: {
      transaction: batch.hash,
      sender: batch.from,
      firstCall: first,
      headUpdates: reading.headUpdates,
      deliveries: delivered,
      gasUsed: receipt.gasUsed.toString(),
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

/**
 * A Multicall3 batch from the copier account, which is not the runner. Anyone may send it, because the router asks nothing
 * of its caller. It holds, in order: a stale update (the head moved past it: it fails), three good deliveries, and the
 * delivery of a message that the runner delivered already (it fails). The two failures must not stop the three deliveries.
 */
const copierBatch = async (context: Context, fresh: readonly MessageRecord[], delivered: MessageRecord, failures: string[]): Promise<void> => {
  const destination = chainOf(context, "b");
  const calls: BatchedCall[] = [];
  const staleProof = findStaleUpdate(context);
  if (staleProof !== null) calls.push({ target: destination.deployment.light_client, callData: staleProof });
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
