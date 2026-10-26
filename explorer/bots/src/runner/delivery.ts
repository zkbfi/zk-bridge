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
  /** The gas the runner assumes for a layout call that it cannot simulate before the call before it is mined. */
  readonly prerequisiteGasFallback: bigint;
  /** The most wei that the layout calls of one sweep may cost. */
  readonly maximumPrerequisiteSpendPerSweepWei: bigint;
}

/**
 * The wei that the layout calls of one sweep have cost so far. The runner makes one ledger for each sweep and passes it
 * to every delivery. Layout rows help every sender, so this spend is a gift that the fee of one item may never repay.
 * The ledger is the one mutable value of a delivery: it must grow at the moment a layout call is mined.
 */
export interface PrerequisiteLedger {
  readonly capWei: bigint;
  spentWei: bigint;
}

/** Makes an empty ledger with a cap in wei. */
export function createPrerequisiteLedger(capWei: bigint): PrerequisiteLedger {
  return { capWei, spentWei: 0n };
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
  | "prerequisite-budget-exhausted"
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
      /** The wei that layout calls cost before the skip. Present only when the runner lost wei. */
      readonly prerequisiteCostWei?: bigint;
    }
  | {
      readonly status: "failed";
      readonly messageId: Hex;
      readonly reason: "transaction-reverted";
      readonly transactionHash: Hex;
      readonly prerequisiteCostWei?: bigint;
    };

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

/** The result of {@link estimatePrerequisites}. */
type PrerequisiteEstimate =
  | { readonly ok: true; readonly gasUnits: bigint }
  | { readonly ok: false; readonly outcome: Skip };

/**
 * Estimates the gas of every layout call that the evidence lists, and sends none. The first call can be simulated now.
 * A later call may depend on the call before it, so a revert there is no proof of a fault: the configured fallback
 * stands in for it. The calls of one function are alternatives, so the sum is an upper bound.
 */
async function estimatePrerequisites(dependencies: DeliveryDependencies, messageId: Hex, evidence: EvidencePackage): Promise<PrerequisiteEstimate> {
  const { settings, chain } = dependencies;
  const listed = evidence.prerequisites.slice(0, settings.maximumPrerequisiteRounds);
  let gasUnits = 0n;
  for (const [index, prerequisite] of listed.entries()) {
    const simulation = await chain.simulate({ to: prerequisite.to as Address, data: prerequisite.data as Hex });
    if (!simulation.ok && index === 0) {
      return { ok: false, outcome: skip(messageId, "prerequisite-reverted", { detail: `${prerequisite.function}: ${simulation.reason}` }) };
    }
    gasUnits += simulation.ok ? simulation.gas : settings.prerequisiteGasFallback;
  }
  return { ok: true, gasUnits };
}

/** The result of {@link satisfyPrerequisites}. The cost is what the calls cost, also when the result is a skip. */
type PrerequisiteResult =
  | { readonly ok: true; readonly evidence: EvidencePackage; readonly costWei: bigint }
  | { readonly ok: false; readonly outcome: Skip; readonly costWei: bigint };

/**
 * Sends the layout calls that the evidence lists, one at a time. After each call the evidence is built again, because
 * the calls of one function are alternatives: the next build lists none of them once a row covers the slot.
 * Each mined call adds its cost to the ledger.
 */
async function satisfyPrerequisites(
  dependencies: DeliveryDependencies,
  ledger: PrerequisiteLedger,
  request: { readonly messageId: Hex; readonly transactionHash: Hex; readonly logIndex: number },
  first: EvidencePackage,
): Promise<PrerequisiteResult> {
  let evidence = first;
  let costWei = 0n;
  for (let round = 0; round < dependencies.settings.maximumPrerequisiteRounds; round += 1) {
    const next: Prerequisite | undefined = evidence.prerequisites[0];
    if (next === undefined) return { ok: true, evidence, costWei };
    const call = { to: next.to as Address, data: next.data as Hex };
    const simulation = await dependencies.chain.simulate(call);
    if (!simulation.ok) return { ok: false, costWei, outcome: skip(request.messageId, "prerequisite-reverted", { detail: `${next.function}: ${simulation.reason}` }) };
    const receipt = await dependencies.chain.send({ ...call, gas: simulation.gas });
    const callCostWei = receipt.gasUsed * receipt.effectiveGasPrice;
    ledger.spentWei += callCostWei;
    costWei += callCostWei;
    if (!receipt.success) return { ok: false, costWei, outcome: skip(request.messageId, "prerequisite-failed", { detail: `${next.function} in ${receipt.hash}` }) };
    dependencies.logger.info("prerequisite_sent", { messageId: request.messageId, function: next.function, transactionHash: receipt.hash, gasUsed: receipt.gasUsed });
    evidence = await dependencies.prover.evidence({ direction: dependencies.direction, transactionHash: request.transactionHash, logIndex: request.logIndex });
    if (evidence.alreadyDelivered) return { ok: false, costWei, outcome: skip(request.messageId, "already-delivered") };
  }
  if (evidence.prerequisites.length === 0) return { ok: true, evidence, costWei };
  return { ok: false, costWei, outcome: skip(request.messageId, "prerequisites-not-satisfied", { detail: `${evidence.prerequisites.length} calls remain` }) };
}

/**
 * Marks a skip with the wei that layout calls cost before it, and logs the loss. A skip with no spend stays as it is.
 */
function recordLoss(dependencies: DeliveryDependencies, outcome: Skip, spentWei: bigint): Skip {
  if (spentWei === 0n) return outcome;
  dependencies.logger.warn("prerequisite_loss", { messageId: outcome.messageId, lossWei: spentWei, reason: outcome.reason });
  return { ...outcome, prerequisiteCostWei: spentWei };
}

/** The gas the runner assumes before it can simulate: the layout calls and one execution. */
function guessGas(settings: DeliverySettings): bigint {
  return settings.executionGasFallback;
}

/**
 * Checks, before any layout call leaves (and does nothing when the evidence lists none), that the offer repays the layout calls and the execution together, and that
 * the sweep has budget for the layout calls. Returns the skip when it does not.
 */
async function approvePrerequisiteSpend(
  dependencies: DeliveryDependencies,
  ledger: PrerequisiteLedger,
  context: { readonly item: FeedItem; readonly offer: FeeOffer; readonly evidence: EvidencePackage; readonly messageId: Hex },
): Promise<Skip | null> {
  const { item, offer, evidence, messageId } = context;
  const { settings, chain } = dependencies;
  if (evidence.prerequisites.length === 0) return null;
  const estimate = await estimatePrerequisites(dependencies, messageId, evidence);
  if (!estimate.ok) return estimate.outcome;
  const quote = await chain.feeQuote();
  const estimatedSpendWei = estimate.gasUnits * (quote.baseFee + quote.priorityFee);
  if (ledger.spentWei + estimatedSpendWei > ledger.capWei) {
    return skip(messageId, "prerequisite-budget-exhausted", {
      costWei: estimatedSpendWei,
      detail: `${ledger.spentWei} of ${ledger.capWei} wei spent this sweep`,
    });
  }
  if (offer.kind !== "offer") return null;
  const judgement = await judgeOffer(dependencies, {
    item,
    offer,
    feeGasUnits: guessGas(settings),
    costGasUnits: estimate.gasUnits + guessGas(settings),
    quote,
    messageId,
  });
  return judgement.kind === "skip" ? judgement.outcome : null;
}

/**
 * Delivers one covered item, or says why not.
 *
 * 1. Read the call data of the message from the indexer and look for a fee offer to the fee router.
 * 2. Price the offer at the assumed gas, and skip when the fee does not cover cost and margin. This check needs no
 *    evidence, so an item that does not pay costs no proving time.
 * 3. Build the evidence (`zk-bridge-prover evidence`). Skip when the message is delivered already.
 * 4. Estimate the gas of every layout call. Require that the fee covers the layout calls and the execution together, plus
 *    the margin, and that the layout calls fit in the budget of the sweep. Skip before any layout call leaves.
 * 5. Send the layout calls that the evidence lists, each after a simulation.
 * 6. Simulate the delivery. Price the offer again at the simulated gas. Skip on a revert, or when it does not pay.
 *    Wei spent on layout calls is lost then: the skip carries the amount and the runner does not retry the item soon.
 * 7. Send `FeeRouter.executeMessageWithRunner(runner, proof)`, or `executeMessage` for an item without an offer when
 *    the configuration allows it.
 *
 * No transaction leaves without a simulation that succeeded.
 */
export async function deliverItem(dependencies: DeliveryDependencies, item: FeedItem, ledger: PrerequisiteLedger): Promise<DeliveryOutcome> {
  const messageId = item.messageId as Hex;
  const { settings, logger, chain } = dependencies;
  const message = await dependencies.indexer.getMessage(item.messageId);
  const offer = readFeeOffer({ messageData: message.data as Hex, feeRouter: dependencies.feeRouter });
  if (offer.kind === "none" && !settings.deliverWithoutOffer) return skip(messageId, "no-fee-offer", { detail: offer.reason });

  const quote = await chain.feeQuote();
  const early =
    offer.kind === "offer"
      ? await judgeOffer(dependencies, { item, offer, feeGasUnits: guessGas(settings), costGasUnits: guessGas(settings), quote, messageId })
      : null;
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

  const refusal = await approvePrerequisiteSpend(dependencies, ledger, { item, offer, evidence, messageId });
  if (refusal !== null) return refusal;

  const prepared = await satisfyPrerequisites(dependencies, ledger, { messageId, transactionHash: sourceTransaction, logIndex }, evidence);
  if (!prepared.ok) return recordLoss(dependencies, prepared.outcome, prepared.costWei);

  const call = buildFinalCall(dependencies, offer, prepared.evidence);
  const simulation = await chain.simulate(call);
  if (!simulation.ok) return recordLoss(dependencies, skip(messageId, "simulation-reverted", { detail: simulation.reason }), prepared.costWei);

  const finalQuote = await chain.feeQuote();
  const final =
    offer.kind === "offer"
      ? await judgeOffer(dependencies, { item, offer, feeGasUnits: simulation.gas, costGasUnits: simulation.gas, quote: finalQuote, messageId })
      : null;
  if (final !== null && final.kind === "skip") return recordLoss(dependencies, final.outcome, prepared.costWei);

  const receipt = await chain.send({ to: call.to, data: call.data, gas: simulation.gas });
  if (!receipt.success) {
    return { status: "failed", messageId, reason: "transaction-reverted", transactionHash: receipt.hash, ...(prepared.costWei > 0n ? { prerequisiteCostWei: prepared.costWei } : {}) };
  }
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

/** Input of {@link judgeOffer}. */
interface JudgeOfferInput {
  readonly item: FeedItem;
  readonly offer: Extract<FeeOffer, { kind: "offer" }>;
  /** The gas that the fee is quoted for: the execution, which the router repays. */
  readonly feeGasUnits: bigint;
  /** The gas that the runner pays for: the execution, and before an execution also the layout calls. */
  readonly costGasUnits: bigint;
  readonly quote: FeeQuote;
  readonly messageId: Hex;
}

/** Prices the offer at the fee gas and compares it with the cost of the cost gas. */
async function judgeOffer(dependencies: DeliveryDependencies, input: JudgeOfferInput): Promise<Judgement> {
  const { item, offer, feeGasUnits, costGasUnits, quote, messageId } = input;
  const priced = await quoteFee(dependencies, item, offer, feeGasUnits);
  if (!priced.ok) return { kind: "skip", outcome: skip(messageId, priced.reason) };
  const decision = decideDelivery({ feeWei: priced.feeWei, gasUnits: costGasUnits, quote, minimumMarginWei: dependencies.settings.minimumMarginWei });
  if (decision.deliver) return { kind: "pay", feeWei: priced.feeWei };
  return {
    kind: "skip",
    outcome: skip(messageId, "fee-below-cost-plus-margin", {
      feeWei: priced.feeWei,
      costWei: decision.costWei,
      detail: `short by ${decision.shortfallWei} wei at ${costGasUnits} gas`,
    }),
  };
}
