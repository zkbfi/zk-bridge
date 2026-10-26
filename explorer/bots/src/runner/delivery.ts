import { decodeEventLog, decodeFunctionData, decodeFunctionResult, encodeFunctionData, erc20Abi, type Address, type Hex } from "viem";
import { feeRouterAbi, messageBridgeAbi, type ProofDirection } from "@zk-bridge/shared";
import type { FeeQuote, ReceiptSummary, TransactionPort } from "../chain/transactions.ts";
import type { FeedItem, IndexerClient } from "../indexer/client.ts";
import type { Logger } from "../logging/logger.ts";
import type { EvidencePackage, Prerequisite } from "../prover/packages.ts";
import type { ProverBinary } from "../prover/prover-binary.ts";
import { decideDelivery, readFeeOffer, valueFeeInWei, type FeeOffer } from "./fee.ts";
import type { SourceReader } from "./source-reader.ts";

/** The settings of a delivery that come from the bot configuration. */
export interface DeliverySettings {
  readonly minimumMarginWei: bigint;
  readonly deliverWithoutOffer: boolean;
  /** The value of one whole token in wei, by lowercase address. */
  readonly tokenValuationsWei: Readonly<Record<string, bigint>>;
  /** The gas the runner assumes for an execution before it can simulate one. */
  readonly executionGasFallback: bigint;
  readonly maximumPrerequisiteRounds: number;
}

/** The parts a delivery touches. Tests pass fakes for every one. */
export interface DeliveryDependencies {
  readonly direction: ProofDirection;
  readonly chain: TransactionPort;
  readonly prover: ProverBinary;
  readonly indexer: IndexerClient;
  readonly source: SourceReader;
  /** The fee router of the destination chain, or null. */
  readonly feeRouter: Address | null;
  readonly wrappedNative: Address;
  readonly settings: DeliverySettings;
  readonly logger: Logger;
}

/** Why the runner did not deliver an item. */
export type SkipReason =
  | "no-fee-offer"
  | "no-price-for-fee-token"
  | "fee-below-cost-plus-margin"
  | "source-log-not-found"
  | "already-delivered"
  | "evidence-failed"
  | "fee-quote-failed"
  | "prerequisite-reverted"
  | "prerequisite-failed"
  | "prerequisites-not-satisfied"
  | "simulation-reverted";

/** The result for one item. The runner writes it to the log and the outcome file. */
export type DeliveryOutcome =
  | {
      readonly status: "delivered";
      readonly messageId: Hex;
      readonly path: "fee-router" | "bridge";
      readonly transactionHash: Hex;
      readonly gasUsed: bigint;
      readonly gasCostWei: bigint;
      readonly prerequisiteCostWei: bigint;
      /** The fee that `feeInfo` promised at the last simulation, in wei. Null when the item had no offer. */
      readonly feeExpectedWei: bigint | null;
      /** The tokens that arrived at the runner, from the receipt. Null when the fee is paid in the native coin or not at all. */
      readonly feeReceivedTokens: bigint | null;
    }
  | {
      readonly status: "skipped";
      readonly messageId: Hex;
      readonly reason: SkipReason;
      readonly detail?: string;
      readonly feeWei?: bigint;
      readonly costWei?: bigint;
    }
  | { readonly status: "failed"; readonly messageId: Hex; readonly reason: "transaction-reverted"; readonly transactionHash: Hex };

/** Whether the runner should never look at the item again. */
export function isFinal(outcome: DeliveryOutcome): boolean {
  if (outcome.status === "delivered") return true;
  return outcome.status === "skipped" && outcome.reason === "already-delivered";
}

type Skip = Extract<DeliveryOutcome, { status: "skipped" }>;

function skip(messageId: Hex, reason: SkipReason, extra: Partial<Omit<Skip, "status" | "messageId" | "reason">> = {}): Skip {
  return { status: "skipped", messageId, reason, ...extra };
}

/** The call that delivers: the evidence calldata for the bridge, or the fee router call that names the runner. */
interface FinalCall {
  readonly to: Address;
  readonly data: Hex;
  readonly path: "fee-router" | "bridge";
}

function buildFinalCall(dependencies: DeliveryDependencies, offer: FeeOffer, evidence: EvidencePackage): FinalCall {
  if (offer.kind === "none" || dependencies.feeRouter === null) {
    return { to: evidence.execute.to as Address, data: evidence.execute.data as Hex, path: "bridge" };
  }
  const decoded = decodeFunctionData({ abi: messageBridgeAbi, data: evidence.execute.data as Hex });
  if (decoded.functionName !== "executeMessage") throw new Error(`the evidence calls ${decoded.functionName}, not executeMessage`);
  const data = encodeFunctionData({
    abi: feeRouterAbi,
    functionName: "executeMessageWithRunner",
    args: [dependencies.chain.account, decoded.args[0]],
  });
  return { to: dependencies.feeRouter, data, path: "fee-router" };
}

/** The fee that the router would pay the runner for this gas, measured in wei. */
async function quoteFee(
  dependencies: DeliveryDependencies,
  item: FeedItem,
  offer: Extract<FeeOffer, { kind: "offer" }>,
  gasUnits: bigint,
): Promise<{ readonly ok: true; readonly feeWei: bigint; readonly feeTokens: bigint } | { readonly ok: false; readonly reason: "no-price-for-fee-token" }> {
  const token = item.transfer?.destinationToken;
  if (token === undefined) return { ok: false, reason: "no-price-for-fee-token" };
  const { director } = offer;
  const data = encodeFunctionData({
    abi: feeRouterAbi,
    functionName: "feeInfo",
    args: [token.address as Address, offer.value, gasUnits, director],
  });
  const answer = await dependencies.chain.call({ to: dependencies.feeRouter as Address, data });
  const [feeTokens] = decodeFunctionResult({ abi: feeRouterAbi, functionName: "feeInfo", data: answer });
  const value = valueFeeInWei({
    fee: feeTokens,
    token: token.address as Address,
    decimals: token.decimals,
    director,
    // The wrapped native token and its unwrapped payout are both worth one wei per base unit.
    wrappedNative: dependencies.wrappedNative,
    valuationsWei: dependencies.settings.tokenValuationsWei,
  });
  return value.ok ? { ok: true, feeWei: value.wei, feeTokens } : value;
}

/** Sums the transfers of `token` to `account` in a receipt. */
function tokensReceived(receipt: ReceiptSummary, token: Address, account: Address): bigint {
  let total = 0n;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== token.toLowerCase()) continue;
    try {
      const event = decodeEventLog({ abi: erc20Abi, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
      if (event.eventName === "Transfer" && event.args.to.toLowerCase() === account.toLowerCase()) total += event.args.value;
    } catch {
      // A log of the same address with another shape is none of our business.
    }
  }
  return total;
}

/**
 * Sends the layout calls that the evidence lists, one at a time. After each call the evidence is built again, because
 * the calls of one function are alternatives: the next build lists none of them once a row covers the slot.
 */
async function satisfyPrerequisites(
  dependencies: DeliveryDependencies,
  request: { readonly messageId: Hex; readonly transactionHash: Hex; readonly logIndex: number },
  first: EvidencePackage,
): Promise<{ readonly ok: true; readonly evidence: EvidencePackage; readonly costWei: bigint } | { readonly ok: false; readonly outcome: Skip }> {
  let evidence = first;
  let costWei = 0n;
  for (let round = 0; round < dependencies.settings.maximumPrerequisiteRounds; round += 1) {
    const next: Prerequisite | undefined = evidence.prerequisites[0];
    if (next === undefined) return { ok: true, evidence, costWei };
    const call = { to: next.to as Address, data: next.data as Hex };
    const simulation = await dependencies.chain.simulate(call);
    if (!simulation.ok) return { ok: false, outcome: skip(request.messageId, "prerequisite-reverted", { detail: `${next.function}: ${simulation.reason}` }) };
    const receipt = await dependencies.chain.send({ ...call, gas: simulation.gas });
    if (!receipt.success) return { ok: false, outcome: skip(request.messageId, "prerequisite-failed", { detail: `${next.function} in ${receipt.hash}` }) };
    costWei += receipt.gasUsed * receipt.effectiveGasPrice;
    dependencies.logger.info("prerequisite_sent", { messageId: request.messageId, function: next.function, transactionHash: receipt.hash, gasUsed: receipt.gasUsed });
    evidence = await dependencies.prover.evidence({ direction: dependencies.direction, transactionHash: request.transactionHash, logIndex: request.logIndex });
    if (evidence.alreadyDelivered) return { ok: false, outcome: skip(request.messageId, "already-delivered") };
  }
  if (evidence.prerequisites.length === 0) return { ok: true, evidence, costWei };
  return { ok: false, outcome: skip(request.messageId, "prerequisites-not-satisfied", { detail: `${evidence.prerequisites.length} calls remain` }) };
}

/** The gas the runner assumes before it can simulate: the layout calls and one execution. */
function guessGas(settings: DeliverySettings): bigint {
  return settings.executionGasFallback;
}

/**
 * Delivers one covered item, or says why not.
 *
 * 1. Read the call data of the message from the indexer and look for a fee offer to the fee router.
 * 2. Price the offer at the assumed gas, and skip when the fee does not cover cost and margin. This check needs no
 *    evidence, so an item that does not pay costs no proving time.
 * 3. Build the evidence (`zk-bridge-prover evidence`). Skip when the message is delivered already.
 * 4. Send the layout calls that the evidence lists, each after a simulation.
 * 5. Simulate the delivery. Price the offer again at the simulated gas. Skip on a revert, or when it does not pay.
 * 6. Send `FeeRouter.executeMessageWithRunner(runner, proof)`, or `executeMessage` for an item without an offer when
 *    the configuration allows it.
 *
 * No transaction leaves without a simulation that succeeded.
 */
export async function deliverItem(dependencies: DeliveryDependencies, item: FeedItem): Promise<DeliveryOutcome> {
  const messageId = item.messageId as Hex;
  const { settings, logger, chain } = dependencies;
  const message = await dependencies.indexer.getMessage(item.messageId);
  const offer = readFeeOffer({ messageData: message.data as Hex, feeRouter: dependencies.feeRouter });
  if (offer.kind === "none" && !settings.deliverWithoutOffer) return skip(messageId, "no-fee-offer", { detail: offer.reason });

  const quote = await chain.feeQuote();
  const early = offer.kind === "offer" ? await judgeOffer(dependencies, item, offer, guessGas(settings), quote, messageId) : null;
  if (early !== null && early.kind === "skip") return early.outcome;

  const sourceTransaction = item.sent?.transactionHash as Hex | undefined;
  if (sourceTransaction === undefined) return skip(messageId, "source-log-not-found", { detail: "the indexer has no send" });
  const logIndex = await dependencies.source.findMessageLogIndex({ transactionHash: sourceTransaction, messageId });
  if (logIndex === null) return skip(messageId, "source-log-not-found");

  let evidence: EvidencePackage;
  try {
    evidence = await dependencies.prover.evidence({ direction: dependencies.direction, transactionHash: sourceTransaction, logIndex });
  } catch (error) {
    return skip(messageId, "evidence-failed", { detail: error instanceof Error ? error.message : String(error) });
  }
  if (evidence.alreadyDelivered) return skip(messageId, "already-delivered", { detail: evidence.deliveryStatus });

  const prepared = await satisfyPrerequisites(dependencies, { messageId, transactionHash: sourceTransaction, logIndex }, evidence);
  if (!prepared.ok) return prepared.outcome;

  const call = buildFinalCall(dependencies, offer, prepared.evidence);
  const simulation = await chain.simulate(call);
  if (!simulation.ok) return skip(messageId, "simulation-reverted", { detail: simulation.reason });

  const finalQuote = await chain.feeQuote();
  const final = offer.kind === "offer" ? await judgeOffer(dependencies, item, offer, simulation.gas, finalQuote, messageId) : null;
  if (final !== null && final.kind === "skip") return final.outcome;

  const receipt = await chain.send({ to: call.to, data: call.data, gas: simulation.gas });
  if (!receipt.success) return { status: "failed", messageId, reason: "transaction-reverted", transactionHash: receipt.hash };
  const token = item.transfer?.destinationToken.address as Address | undefined;
  const feeReceivedTokens = call.path === "fee-router" && token !== undefined ? tokensReceived(receipt, token, chain.account) : null;
  logger.info("delivery_sent", { messageId, path: call.path, transactionHash: receipt.hash, gasUsed: receipt.gasUsed });
  return {
    status: "delivered",
    messageId,
    path: call.path,
    transactionHash: receipt.hash,
    gasUsed: receipt.gasUsed,
    gasCostWei: receipt.gasUsed * receipt.effectiveGasPrice,
    prerequisiteCostWei: prepared.costWei,
    feeExpectedWei: final !== null && final.kind === "pay" ? final.feeWei : null,
    feeReceivedTokens,
  };
}

type Judgement = { readonly kind: "pay"; readonly feeWei: bigint } | { readonly kind: "skip"; readonly outcome: Skip };

/** Prices the offer at a gas figure and compares it with the cost. */
async function judgeOffer(
  dependencies: DeliveryDependencies,
  item: FeedItem,
  offer: Extract<FeeOffer, { kind: "offer" }>,
  gasUnits: bigint,
  quote: FeeQuote,
  messageId: Hex,
): Promise<Judgement> {
  const priced = await quoteFee(dependencies, item, offer, gasUnits);
  if (!priced.ok) return { kind: "skip", outcome: skip(messageId, priced.reason) };
  const decision = decideDelivery({ feeWei: priced.feeWei, gasUnits, quote, minimumMarginWei: dependencies.settings.minimumMarginWei });
  if (decision.deliver) return { kind: "pay", feeWei: priced.feeWei };
  return {
    kind: "skip",
    outcome: skip(messageId, "fee-below-cost-plus-margin", {
      feeWei: priced.feeWei,
      costWei: decision.costWei,
      detail: `short by ${decision.shortfallWei} wei at ${gasUnits} gas`,
    }),
  };
}
