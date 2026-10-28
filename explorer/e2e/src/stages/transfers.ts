/**
 * Transfers through the terminal and their deliveries (step 3 of the run).
 *
 * A round sends several transfers from one chain, posts the light client update that covers them, and delivers each one
 * on the other chain by the path that the case names. After each delivery the stage reads the balances in the block before
 * and in the block of the delivery, and checks the split: the tip to the reward address, the rest to the recipient, and
 * what the router handed off.
 */
import { decodeEventLog, encodeFunctionData, erc20Abi, parseAbi, type Address, type Hex } from "viem";
import { deliveryRouterAbi } from "@zk-bridge/shared";
import { accountOf, chainOf, otherSide, sendFrom, type Context, type Role, type Side } from "../context.ts";
import { execute, readyEvidence, type DeliveryPath, type MessageRecord } from "../delivery.ts";
import { record } from "../results.ts";
import { relayThroughTerminal, sideOf, startTerminalServices, type RelayRequest, type TerminalRelay, type TerminalServices } from "../terminal.ts";
import { ensureGateConfirmed } from "./gate.ts";
import { balanceChange, nativeTokens, terminalTokens, valuationsWei, copyOf, type RunToken } from "../tokens.ts";
import { loadMessages, saveMessage } from "../messages.ts";

const WHOLE = 10n ** 18n;

/** What a case expects of the split. All amounts are in base units of the token that the destination pays out. */
type Expectation =
  | { readonly kind: "tip-positive" }
  | { readonly kind: "tip-exact"; readonly tip: bigint }
  | { readonly kind: "no-tip" }
  | { readonly kind: "handed-off"; readonly tip: bigint };

/** One transfer of a round. */
interface Case {
  readonly name: string;
  readonly from: Side;
  /** The native token that moves, or `native` for the wrap route. */
  readonly token: RunToken["key"] | "native";
  /** True when the token of the case is the bridged copy of a token of the other chain, not a native token. */
  readonly copy?: boolean;
  readonly amount: bigint;
  readonly sender: Role;
  readonly recipient: Role;
  /** The form values of the delivery fee. `delivery: "no"` is a plain relay. */
  readonly fee: Readonly<Record<string, string>>;
  readonly path: DeliveryPath;
  readonly expect: Expectation;
  /** The payout is the native coin (an unwrap delivery). */
  readonly nativePayout?: boolean;
}

const ROUND_A: readonly Case[] = [
  { name: "a-default-tip", from: "a", token: "tokenA", amount: 100n * WHOLE, sender: "senderOne", recipient: "recipient", fee: { delivery: "yes" }, path: "router", expect: { kind: "tip-positive" } },
  { name: "a-percent-tip", from: "a", token: "tokenA", amount: 100n * WHOLE, sender: "senderOne", recipient: "recipientTwo", fee: { delivery: "yes", feeMode: "percentage", feePercent: "0.1" }, path: "router", expect: { kind: "tip-exact", tip: WHOLE / 10n } },
  { name: "a-fixed-tip", from: "a", token: "tokenA", amount: 100n * WHOLE, sender: "senderOne", recipient: "recipientThree", fee: { delivery: "yes", feeMode: "fixed", feeFixed: "0.5" }, path: "router", expect: { kind: "tip-exact", tip: WHOLE / 2n } },
  { name: "a-plain-relay", from: "a", token: "tokenA", amount: 40n * WHOLE, sender: "senderOne", recipient: "recipient", fee: { delivery: "no" }, path: "bridge", expect: { kind: "no-tip" } },
  { name: "a-tipped-delivered-directly", from: "a", token: "tokenA", amount: 60n * WHOLE, sender: "senderOne", recipient: "recipientTwo", fee: { delivery: "yes" }, path: "bridge", expect: { kind: "no-tip" } },
  { name: "a-native-wrap", from: "a", token: "native", amount: 1n * WHOLE, sender: "senderOne", recipient: "senderTwo", fee: { delivery: "no" }, path: "bridge", expect: { kind: "no-tip" } },
  { name: "a-blockable-to-sender-two", from: "a", token: "blockableA", amount: 50n * WHOLE, sender: "senderOne", recipient: "senderTwo", fee: { delivery: "no" }, path: "bridge", expect: { kind: "no-tip" } },
];

const ROUND_B: readonly Case[] = [
  { name: "b-default-tip", from: "b", token: "tokenB", amount: 100n * WHOLE, sender: "senderTwo", recipient: "recipient", fee: { delivery: "yes" }, path: "router", expect: { kind: "tip-positive" } },
  { name: "b-unwrap-tip", from: "b", token: "wrappedA", copy: true, amount: WHOLE / 2n, sender: "senderTwo", recipient: "recipientTwo", fee: { delivery: "yes", feeMode: "fixed", feeFixed: "0.01", feePayout: "native" }, path: "router", expect: { kind: "tip-exact", tip: WHOLE / 100n }, nativePayout: true },
  { name: "b-refused-payout", from: "b", token: "blockableA", copy: true, amount: 20n * WHOLE, sender: "senderTwo", recipient: "recipientThree", fee: { delivery: "yes", feeMode: "percentage", feePercent: "1" }, path: "router", expect: { kind: "handed-off", tip: (20n * WHOLE) / 100n } },
  { name: "b-plain-relay", from: "b", token: "tokenB", amount: 30n * WHOLE, sender: "senderTwo", recipient: "recipientTwo", fee: { delivery: "no" }, path: "bridge", expect: { kind: "no-tip" } },
];

/** Mints the test tokens to the senders (a public mint). */
export const fundSenders = async (context: Context): Promise<void> => {
  const mint = async (side: Side, token: Address, to: Role, amount: bigint) => {
    const data = encodeFunctionData({ abi: parseAbi(["function mint(address to, uint256 amount)"]), functionName: "mint", args: [accountOf(to).address, amount] });
    await sendFrom(chainOf(context, side), "deployer", { to: token, data }, "mint");
  };
  await mint("a", context.run.tokens.a, "senderOne", 1_000n * WHOLE);
  await mint("a", context.run.tokens.blockableA, "senderOne", 1_000n * WHOLE);
  await mint("b", context.run.tokens.b, "senderTwo", 1_000n * WHOLE);
  record(context, { stage: "transfers", name: "fund-senders", ok: true, data: {} });
};

/** The tokens that have code on their chain now, in the shape of the terminal. A copy exists only after its first delivery. */
const liveTokens = async (context: Context) => {
  const all = await terminalTokens(context);
  const live = [];
  for (const token of all) {
    const chain = token.side === "first" ? context.a : context.b;
    const code = await chain.publicClient.getCode({ address: token.address });
    if (code !== undefined && code !== "0x") live.push(token);
  }
  return live;
};

/** Starts the services of the terminal for the run. */
export const startServices = async (context: Context, indexerUrl: string): Promise<TerminalServices> =>
  startTerminalServices(context, { indexerUrl, valuationsWei: await valuationsWei(context) });

/** The address of the token a case moves, on the source chain. */
const sourceTokenOf = async (context: Context, item: Case): Promise<Address | "native"> => {
  if (item.token === "native") return "native";
  const token = nativeTokens(context).find((candidate) => candidate.key === item.token);
  if (token === undefined) throw new Error(`no token ${item.token}`);
  return item.copy === true ? copyOf(context, token) : token.address;
};

/** The token that the destination pays out for a case, and whether it is the native coin. */
const payoutTokenOf = async (context: Context, item: Case): Promise<Address> => {
  if (item.token === "native") return copyOf(context, nativeTokens(context).find((candidate) => candidate.key === "wrappedA")!);
  const token = nativeTokens(context).find((candidate) => candidate.key === item.token)!;
  // A copy moves back to its home chain, where the payout token is the native token. A native token pays its copy.
  return item.copy === true ? token.address : copyOf(context, token);
};

/**
 * Sends a relay after the gate confirmed the epoch. The first sender of an epoch confirms it. A send that lands in the next
 * epoch is refused by the gate, so the call confirms again and tries once more.
 */
export const relayWithGate = async (context: Context, services: TerminalServices, request: RelayRequest): Promise<TerminalRelay> => {
  for (let attempt = 1; ; attempt += 1) {
    await ensureGateConfirmed(context, request.from, "transfers");
    try {
      return await relayThroughTerminal(context, services, request);
    } catch (error) {
      if (attempt >= 3) throw error;
      console.log(`${request.label}: attempt ${attempt} failed (${(error as Error).message.slice(0, 160)}). Confirming the gate again.`);
    }
  }
};

/** Sends every case of a round through the terminal, and saves the messages. */
export const sendRound = async (context: Context, services: TerminalServices, round: "a" | "b"): Promise<void> => {
  const cases = round === "a" ? ROUND_A : ROUND_B;
  for (const item of cases) {
    const tokens = await liveTokens(context);
    const sourceToken = await sourceTokenOf(context, item);
    const values: Record<string, string> = {
      token: sourceToken === "native" ? `${sideOf(item.from)}:native` : `${sideOf(item.from)}:${sourceToken}`,
      amount: (Number(item.amount) / 1e18).toString(),
      receiver: accountOf(item.recipient).address,
      ...item.fee,
    };
    if (item.fee.delivery === "no") values.mode = "plain";
    const relay = await relayWithGate(context, services, { from: item.from, role: item.sender, values, tokens, label: item.name });
    const message: MessageRecord = { name: item.name, from: item.from, transactionHash: relay.relayHash, logIndex: relay.messageLogIndex, messageId: relay.messageId };
    saveMessage(context, message);
    record(context, {
      stage: "transfers",
      name: `sent-${item.name}`,
      ok: true,
      data: { steps: relay.steps.map((step) => step.title).join(" + "), sendGas: relay.receipt.gasUsed.toString(), transaction: relay.relayHash, block: relay.receipt.blockNumber.toString() },
    });
  }
};

/** What a delivery changed, read from the balances at the block of the delivery. */
interface Split {
  readonly tip: bigint;
  readonly toRecipient: bigint;
  readonly handedOff: bigint;
}

const split = async (context: Context, item: Case, side: Side, payoutToken: Address, blockNumber: bigint): Promise<Split> => {
  const token: Address | "native" = item.nativePayout === true ? "native" : payoutToken;
  const reward = accountOf("reward").address;
  const failed = accountOf("failedDelivery").address;
  const recipient = accountOf(item.recipient).address;
  return {
    tip: await balanceChange(context, side, token, reward, blockNumber),
    toRecipient: await balanceChange(context, side, token, recipient, blockNumber),
    // The router hands a refused amount off in the token it holds: the wrapped token for a coin payout.
    handedOff: await balanceChange(context, side, payoutToken, failed, blockNumber),
  };
};

/**
 * Waits until the source chain has mined a few blocks after the newest message of a round. The finalized header of the
 * synthetic beacon chain lies two slots behind the tip, so one update then covers every message of the round.
 */
export const waitForFinality = async (context: Context, side: Side, messages: readonly MessageRecord[]): Promise<void> => {
  const chain = chainOf(context, side);
  const blocks = await Promise.all(messages.map(async (message) => (await chain.publicClient.getTransactionReceipt({ hash: message.transactionHash })).blockNumber));
  const wanted = blocks.reduce((largest, block) => (block > largest ? block : largest), 0n) + 5n;
  while ((await chain.publicClient.getBlockNumber()) < wanted) await new Promise((done) => setTimeout(done, 1_000));
};

/** Delivers the messages of a round on the other chain and checks the split of each. */
export const deliverRound = async (context: Context, round: "a" | "b"): Promise<void> => {
  const cases = round === "a" ? ROUND_A : ROUND_B;
  const messages = loadMessages(context);
  const destinationSide = otherSide(round);
  const destination = chainOf(context, destinationSide);
  await waitForFinality(context, round, messages.filter((message) => message.from === round));
  for (const item of cases) {
    const message = messages.find((candidate) => candidate.name === item.name);
    if (message === undefined) throw new Error(`message ${item.name} was not sent`);
    if (item.name === "b-refused-payout") {
      await sendFrom(destination, "deployer", { to: context.run.tokens.blockableA, data: setBlockedData(accountOf(item.recipient).address), gas: 100_000n }, "block recipient");
    }
    const evidence = await readyEvidence(context, message, "transfers");
    const payoutToken = await payoutTokenOf(context, item);
    const delivered = await execute(context, message, { path: item.path, role: "runner", evidence });
    const blockNumber = delivered.sent.receipt.blockNumber;
    const outcome = await split(context, item, destinationSide, payoutToken, blockNumber);
    const block = await destination.publicClient.getBlock({ blockNumber });
    const failures = checkExpectation(item, outcome);
    record(context, {
      stage: "transfers",
      name: `delivered-${item.name}`,
      ok: failures.length === 0,
      data: {
        path: item.path,
        gasUsed: delivered.sent.gasUsed.toString(),
        baseFeePerGas: (block.baseFeePerGas ?? 0n).toString(),
        tipToReward: outcome.tip.toString(),
        toRecipient: outcome.toRecipient.toString(),
        handedOffToFailedDeliveryAddress: outcome.handedOff.toString(),
        transaction: delivered.sent.hash,
        problems: failures.join("; ") || null,
      },
    });
    if (failures.length > 0) throw new Error(`${item.name}: ${failures.join("; ")}`);
  }
};

const setBlockedData = (account: Address): Hex =>
  encodeFunctionData({ abi: parseAbi(["function setBlocked(address account, bool isBlocked)"]), functionName: "setBlocked", args: [account, true] });

/** Compares a split with what the case expects. Returns the problems. */
export const checkExpectation = (item: Pick<Case, "amount" | "expect">, outcome: Split): string[] => {
  const problems: string[] = [];
  const total = item.amount;
  const expected = item.expect;
  if (expected.kind === "no-tip") {
    if (outcome.tip !== 0n) problems.push(`a tip of ${outcome.tip} was paid, none expected`);
    if (outcome.toRecipient !== total) problems.push(`the recipient got ${outcome.toRecipient}, expected ${total}`);
    return problems;
  }
  if (expected.kind === "tip-positive") {
    if (outcome.tip <= 0n) problems.push("no tip was paid");
    if (outcome.tip + outcome.toRecipient !== total) problems.push(`tip ${outcome.tip} plus recipient ${outcome.toRecipient} is not ${total}`);
    return problems;
  }
  if (expected.kind === "tip-exact") {
    if (outcome.tip !== expected.tip) problems.push(`the tip is ${outcome.tip}, expected ${expected.tip}`);
    if (outcome.toRecipient !== total - expected.tip) problems.push(`the recipient got ${outcome.toRecipient}, expected ${total - expected.tip}`);
    return problems;
  }
  if (outcome.tip !== expected.tip) problems.push(`the tip is ${outcome.tip}, expected ${expected.tip}`);
  if (outcome.toRecipient !== 0n) problems.push(`the recipient got ${outcome.toRecipient}, expected nothing`);
  if (outcome.handedOff !== total - expected.tip) problems.push(`${outcome.handedOff} was handed off, expected ${total - expected.tip}`);
  return problems;
};

/** The events of a router delivery, for the report: how many `DeliveryFailed` logs the receipt holds. */
export const deliveryFailedCount = (logs: readonly { readonly data: Hex; readonly topics: readonly Hex[]; readonly address: Address }[], router: Address): number =>
  logs.filter((log) => {
    if (log.address.toLowerCase() !== router.toLowerCase()) return false;
    try {
      return decodeEventLog({ abi: deliveryRouterAbi, data: log.data, topics: log.topics as [Hex, ...Hex[]] }).eventName === "DeliveryFailed";
    } catch {
      return false;
    }
  }).length;

/** The balance of an account in a token, for the checks that need a current value. */
export const currentBalance = async (context: Context, side: Side, token: Address, account: Address): Promise<bigint> =>
  (await chainOf(context, side).publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [account] })) as bigint;
