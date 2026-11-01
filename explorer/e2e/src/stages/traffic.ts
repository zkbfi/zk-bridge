/**
 * The traffic bot on the local chains (docs/testnet-run.md, "Test tokens and traffic"). Real: the deploy script of the test
 * tokens (`script/testnet/DeployTestTokens.s.sol`), the traffic bot (`zk-bridge-bot traffic --once`), the indexer, the
 * light client updates (oracle proofs in the default run) and the delivery runner. The stage:
 *
 * 1. deploys tUSD and tTKN on both chains with the script and mints to the traffic wallet;
 * 2. sends once in each direction: each chain's native tUSD goes out. These first transfers are deploy messages, which
 *    the runner cannot price (`no-price-for-fee-token`): the stage delivers them by hand through the delivery router, as
 *    anyone may;
 * 3. sends again in each direction: the copies go home. It posts an update on each light client and lets the runner
 *    deliver both, through the delivery router, for the dapp's default tip, and checks the balances;
 * 4. sends once more: every send is an ordinary release now, and the runner delivers them.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { erc20Abi, parseAbiItem, type Address, type Hex } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { tokenFactoryAbi } from "@zk-bridge/shared";
import { ANVIL_MNEMONIC, accountOf, chainOf, otherSide, type Context, type Side } from "../context.ts";
import { record } from "../results.ts";
import { spawnBackground, stopBackground, waitUntil, type Background } from "../processes.ts";
import { execute, readyEvidence } from "../delivery.ts";
import { findMessageLog } from "../terminal.ts";
import { ensureGateConfirmed } from "./gate.ts";
import { postUpdate } from "./updates.ts";

/** The traffic wallet: an index of the public mnemonic that no other stage uses. */
const TRAFFIC_INDEX = 12;
const trafficAccount = () => mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: TRAFFIC_INDEX });
const keyOf = (index: number): Hex => `0x${Buffer.from(mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: index }).getHdKey().privateKey!).toString("hex")}`;

const paths = (context: Context) => ({
  tokens: join(context.stateDirectory, "test-tokens.json"),
  setup: join(context.stateDirectory, "traffic-setup.json"),
  out: join(context.stateDirectory, "traffic-out.json"),
  back: join(context.stateDirectory, "traffic-back.json"),
  state: join(context.stateDirectory, "traffic-state"),
  boardUrl: join(context.stateDirectory, "traffic-board.url"),
});

interface TokenFile {
  readonly [chainId: string]: { readonly tokens: Readonly<Record<string, { readonly address: Address; readonly decimals: number }>> };
}

/** Deploys the test tokens on both chains with the forge script, and mints a million of each to the traffic wallet. */
const deployTokens = async (context: Context): Promise<TokenFile> => {
  const file = paths(context).tokens;
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")) as TokenFile;
  // The script may write only under deploy/deployments (foundry.toml). The run moves the file into its state directory.
  const scratch = "deploy/deployments/e2e-run.test-tokens.json";
  for (const side of ["a", "b"] as const) {
    const chain = chainOf(context, side);
    await Bun.$`forge script script/testnet/DeployTestTokens.s.sol --rpc-url ${chain.rpcUrl} --unlocked --sender ${accountOf("deployer").address} --broadcast --slow`
      .cwd(context.repositoryRoot)
      .env({ ...(process.env as Record<string, string>), TRAFFIC_WALLET: trafficAccount().address, TEST_TOKENS_FILE: scratch })
      .quiet();
  }
  renameSync(join(context.repositoryRoot, scratch), file);
  const tokens = JSON.parse(readFileSync(file, "utf8")) as TokenFile;
  record(context, { stage: "traffic", name: "test-tokens", ok: true, data: { file, chains: Object.keys(tokens).join(",") } });
  return tokens;
};

/** The bridged copy of a token, predicted by the factory of the other chain. */
const copyOf = async (context: Context, home: Side, token: Address): Promise<Address> => {
  const other = chainOf(context, otherSide(home));
  return (await other.publicClient.readContract({
    address: other.deployment.token_factory,
    abi: tokenFactoryAbi,
    functionName: "predictAddress",
    args: [BigInt(chainOf(context, home).deployment.chain_id), token],
  })) as Address;
};

/** Every test token and every copy, at one whole coin each: the runner prices a tip only in a token it has a value for. */
const valuations = async (context: Context, tokens: TokenFile): Promise<Record<string, string>> => {
  const entries: Record<string, string> = {};
  for (const side of ["a", "b"] as const) {
    const section = tokens[String(chainOf(context, side).deployment.chain_id)];
    for (const token of Object.values(section?.tokens ?? {})) {
      entries[token.address.toLowerCase()] = "1000000000000000000";
      entries[(await copyOf(context, side, token.address)).toLowerCase()] = "1000000000000000000";
    }
  }
  return entries;
};

/** Writes the setup file and two configurations: the way out, and the way back (native tokens held back by their band). */
const writeConfiguration = async (context: Context, tokens: TokenFile): Promise<void> => {
  const file = paths(context);
  mkdirSync(file.state, { recursive: true });
  const env = (variable: string) => ({ source: "environment", variable });
  writeFileSync(
    file.setup,
    JSON.stringify({
      schemaVersion: 1,
      endpointUrl: "",
      runpodApiKey: null,
      chains: { "1": { rpc: env("E2E_RPC_A"), beacon: env("E2E_BEACON_A") }, "369": { rpc: env("E2E_RPC_B"), beacon: env("E2E_BEACON_B") } },
      msgboardUrl: env("E2E_MSGBOARD_URL"),
      pair: "eth-pls",
      directions: ["first-to-second", "second-to-first"],
      policy: { proveWhenTransferWaits: false, intervalSeconds: 0 },
    }),
  );
  const indexerUrl = Bun.env.E2E_INDEXER_URL ?? "http://127.0.0.1:42069";
  const runner = {
    prover: { binary: context.proverBinary, timeoutSeconds: 600 },
    acceptOracleProof: context.backend !== "remote",
    indexerUrl,
    signer: { kind: "private-key", key: "env:E2E_RUNNER_KEY" },
    pollSeconds: 5,
    maximumLossPercent: 20,
    multicall3: context.run.multicall3,
    tokenValuationsWei: await valuations(context, tokens),
    priorityFeeWei: "1",
    maximumPrerequisiteSpendPerSweepWei: "50000000000000000",
    maximumPrerequisiteSpendPerDayWei: "200000000000000000",
    maximumUnrecoveredPrerequisiteLossWei: "100000000000000000",
    receiptTimeoutSeconds: 120,
  };
  const traffic = (balanceMinimum: string, balanceMaximum: string) => ({
    signer: { kind: "private-key", key: "env:E2E_TRAFFIC_KEY" },
    tokensFile: file.tokens,
    tokens: {
      tUSD: { amount: { minimum: "5", maximum: "50" }, balance: { minimum: balanceMinimum, maximum: balanceMaximum } },
    },
    minimumNativeWei: { "1": "1000000000000000000", "369": "1000000000000000000" },
    receiptTimeoutSeconds: 120,
  });
  const base = { schemaVersion: 1, setupFile: file.setup, deploymentFile: join(context.stateDirectory, "deployment.json"), stateDirectory: file.state, logLevel: "info" };
  writeFileSync(file.out, JSON.stringify({ ...base, runner, traffic: traffic("100000", "990000") }, null, 2));
  // A minimum above the whole mint holds every native token back, so only the copies can go: the way home.
  writeFileSync(file.back, JSON.stringify({ ...base, runner, traffic: traffic("2000000", "3000000") }, null, 2));
};

const environmentOf = (context: Context, boardUrl: string): Record<string, string> => ({
  ...(process.env as Record<string, string>),
  E2E_RPC_A: context.a.rpcUrl,
  E2E_RPC_B: context.b.rpcUrl,
  E2E_BEACON_A: `${context.beaconUrl}/a`,
  E2E_BEACON_B: `${context.beaconUrl}/b`,
  E2E_MSGBOARD_URL: boardUrl,
  E2E_RUNNER_KEY: keyOf(2),
  E2E_TRAFFIC_KEY: keyOf(TRAFFIC_INDEX),
});

/** One `traffic_sent` line of the bot's log. */
interface Sent {
  readonly direction: "first-to-second" | "second-to-first";
  readonly symbol: string;
  readonly kind: "native" | "copy";
  readonly tokenAddress: Address;
  readonly amount: string;
  readonly transactionHash: Hex;
  readonly messageId: Hex;
  readonly gasUsed: string;
}

/** Runs `traffic --once` and returns the sends it logged. Both directions must send. */
const sendOnce = async (context: Context, config: string, environment: Record<string, string>, label: string): Promise<readonly Sent[]> => {
  // Both gates of the local run enforce (both chains have the beacon roots contract).
  await ensureGateConfirmed(context, "a", "traffic");
  await ensureGateConfirmed(context, "b", "traffic");
  // The log file of a label grows over runs: read only what this run writes.
  const logFile = join(context.stateDirectory, "logs", `${label}.log`);
  const offset = existsSync(logFile) ? readFileSync(logFile).length : 0;
  const bot = await spawnBackground(context, label, ["node", join(context.repositoryRoot, "explorer/bots/bin/zk-bridge-bot.mjs"), "traffic", "--config", config, "--once"], environment, join(context.repositoryRoot, "explorer/bots"));
  await bot.exited;
  const lines = readFileSync(bot.logFile).subarray(offset).toString("utf8").split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line) as Record<string, unknown>);
  const sent = lines.filter((line) => line.event === "traffic_sent") as unknown as Sent[];
  const problems = lines.filter((line) => line.event === "traffic_skipped" || line.event === "traffic_failed" || line.event === "step_failed");
  if (bot.exitCode !== 0 || sent.length !== 2 || problems.length > 0) {
    throw new Error(`${label}: exit ${bot.exitCode}, ${sent.length} sends, problems ${JSON.stringify(problems).slice(0, 600)}`);
  }
  const approvals = lines.filter((line) => line.event === "traffic_approved");
  for (const item of sent) {
    const receipt = await chainOf(context, item.direction === "first-to-second" ? "a" : "b").publicClient.getTransactionReceipt({ hash: item.transactionHash });
    record(context, { stage: "traffic", name: `${label}-${item.direction}`, ok: receipt.status === "success", data: { symbol: item.symbol, kind: item.kind, amount: item.amount, relayGas: item.gasUsed, messageId: item.messageId, approvals: approvals.length } });
  }
  return sent;
};

const AFFIRMATION = parseAbiItem("event AffirmationCompleted(address indexed sender, address indexed executor, bytes32 indexed messageId, bool status)");

/** Whether the bridge of a side executed a message. */
const delivered = async (context: Context, side: Side, messageId: Hex): Promise<boolean> => {
  const chain = chainOf(context, side);
  const logs = await chain.publicClient.getLogs({ address: chain.deployment.bridge, event: AFFIRMATION, args: { messageId }, fromBlock: 0n });
  return logs.length > 0;
};

/** Posts an update on both light clients once the sends are final, then lets the runner deliver every send, or delivers by hand. */
const deliverAll = async (context: Context, sent: readonly Sent[], runner: Background, by: "runner" | "hand" = "runner"): Promise<void> => {
  for (const from of ["a", "b"] as const) {
    const chain = chainOf(context, from);
    const mine = sent.filter((item) => (item.direction === "first-to-second") === (from === "a"));
    const blocks = await Promise.all(mine.map(async (item) => (await chain.publicClient.getTransactionReceipt({ hash: item.transactionHash })).blockNumber));
    const wanted = blocks.reduce((largest, block) => (block > largest ? block : largest), 0n) + 5n;
    while ((await chain.publicClient.getBlockNumber()) < wanted) await new Promise((done) => setTimeout(done, 1_000));
    await postUpdate(context, from, "traffic");
  }
  for (const item of sent) {
    const destination: Side = item.direction === "first-to-second" ? "b" : "a";
    if (by === "hand") {
      const from = otherSide(destination);
      const receipt = await chainOf(context, from).publicClient.getTransactionReceipt({ hash: item.transactionHash });
      const log = findMessageLog(receipt, chainOf(context, from).deployment.bridge);
      const message = { name: `traffic-${item.direction}`, from, transactionHash: item.transactionHash, logIndex: log.messageLogIndex, messageId: log.messageId };
      const evidence = await readyEvidence(context, message, "traffic");
      await execute(context, message, { path: "router", role: "copier", evidence });
    }
    await waitUntil(`the runner to deliver ${item.symbol} ${item.direction}`, async () => ((await delivered(context, destination, item.messageId)) ? true : undefined), 300_000);
    record(context, { stage: "traffic", name: `delivered-${item.kind}-${item.direction}`, ok: true, data: { symbol: item.symbol, messageId: item.messageId, by } });
  }
  if (runner.exitCode !== null) throw new Error(`the runner exited with ${runner.exitCode}`);
};

/** The wallet's balance of a token on a side. */
const balanceOf = async (context: Context, side: Side, token: Address): Promise<bigint> =>
  (await chainOf(context, side).publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [trafficAccount().address] })) as bigint;

export const runTraffic = async (context: Context): Promise<void> => {
  const started: Background[] = [];
  try {
    const tokens = await deployTokens(context);
    for (const side of ["a", "b"] as const) {
      await chainOf(context, side).publicClient.request({ method: "anvil_setBalance" as never, params: [trafficAccount().address, "0x21e19e0c9bab2400000"] as never });
    }
    await writeConfiguration(context, tokens);
    const file = paths(context);
    const board = await spawnBackground(context, "traffic-board", ["bun", "run", join(context.repositoryRoot, "explorer/e2e/src/board.ts"), file.boardUrl], process.env as Record<string, string>);
    started.push(board);
    const boardUrl = await waitUntil("the board URL", () => (existsSync(file.boardUrl) ? readFileSync(file.boardUrl, "utf8") : undefined), 30_000);
    const environment = environmentOf(context, boardUrl);
    const runner = await spawnBackground(context, "traffic-runner", ["node", join(context.repositoryRoot, "explorer/bots/bin/zk-bridge-bot.mjs"), "runner", "--config", file.out], environment, join(context.repositoryRoot, "explorer/bots"));
    started.push(runner);

    // 1. The first send of each native token is a deploy message, which the runner cannot price: deliver it by hand.
    const first = await sendOnce(context, file.out, environment, "traffic-first");
    if (first.some((item) => item.kind !== "native")) throw new Error("the first round sent a copy");
    await deliverAll(context, first, runner, "hand");

    // 2. The copies go home (the native tokens wait for that), and the runner delivers them.
    const homeBefore = new Map<string, bigint>();
    for (const item of first) homeBefore.set(item.tokenAddress.toLowerCase(), await balanceOf(context, item.direction === "first-to-second" ? "a" : "b", item.tokenAddress));
    const back = await sendOnce(context, file.back, environment, "traffic-back");
    if (back.some((item) => item.kind !== "copy" || !item.symbol.startsWith("z"))) throw new Error(`the way back sent a native token: ${JSON.stringify(back)}`);
    await deliverAll(context, back, runner);

    // Each copy went home: the wallet holds the returned amount of the native token again, less the tip of 0.1 percent.
    const problems: string[] = [];
    for (const item of back) {
      const home: Side = item.direction === "first-to-second" ? "b" : "a";
      const native = first.find((sent) => (sent.direction === "first-to-second" ? "a" : "b") === home);
      if (native === undefined) continue;
      const after = await balanceOf(context, home, native.tokenAddress);
      const before = homeBefore.get(native.tokenAddress.toLowerCase()) ?? 0n;
      const amount = BigInt(item.amount);
      if (after - before !== amount - amount / 1000n) problems.push(`${item.symbol} home: got ${after - before}, expected ${amount - amount / 1000n}`);
    }
    record(context, { stage: "traffic", name: "round-trip", ok: problems.length === 0, data: { problems: problems.join("; ") || null } });
    if (problems.length > 0) throw new Error(problems.join("; "));

    // 3. A copy came home, so every send is an ordinary release now (a native token or the rest of a copy, as the bot
    // picks), and the runner delivers each.
    const out = await sendOnce(context, file.out, environment, "traffic-out");
    await deliverAll(context, out, runner);
  } finally {
    await Promise.all(started.map((background) => stopBackground(background)));
  }
};
