import { decodeEventLog, decodeFunctionData, decodeFunctionResult, encodeFunctionData, erc20Abi, type Address, type ContractFunctionArgs, type Hex } from "viem";
import { deliveryRouterAbi, messageBridgeAbi, tokenFactoryAbi, type PayoutKind, type ProofDirection } from "@zk-bridge/shared";
import { sendTerms, worstCaseCostWei, type FeeQuote, type ReceiptLog, type TransactionPort } from "../chain/transactions.ts";
import type { FeedItem, IndexerClient } from "../indexer/client.ts";
import type { Logger } from "../logging/logger.ts";
import type { EvidencePackage, Prerequisite, ProverBinary } from "@zk-bridge/shared/prover";
import type { PrerequisiteLedger } from "./prerequisite-ledger.ts";
import { decideDelivery, feeGasUnitsOf, payoutOfOffer, readFeeOffer, valueFeeInWei, type FeeOffer } from "./fee.ts";
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
  /** The most wei that layout calls may cost, reservations included, in a rolling 24 hours. The state file keeps it. */
  readonly maximumPrerequisiteSpendPerDayWei: bigint;
  /** The unrecovered loss of a rolling 24 hours at which the runner stops sending layout calls. */
  readonly maximumUnrecoveredPrerequisiteLossWei: bigint;
  /** The most items that one batch transaction delivers. */
  readonly maximumBatchSize: number;
  /** The most gas that one batch may use: the sum of the assumed gas of its items, and the upper bound of its gas limit. */
  readonly maximumBatchGas: bigint;
}

/** The parts a delivery touches. Tests pass fakes for every one. */
export interface DeliveryDependencies {
  readonly direction: ProofDirection;
  readonly chain: TransactionPort;
  readonly prover: ProverBinary;
  readonly indexer: IndexerClient;
  readonly source: SourceReader;
  /** The delivery router of the destination chain, or null. */
  readonly deliveryRouter: Address | null;
  /** The Multicall3 contract of the destination chain, which batches the calls of a delivery. Not null whenever `deliveryRouter` is not null. */
  readonly multicall: Address | null;
  /** The address that receives the tips, read from the router at start up. It serves the accounting and the log. Not null whenever `deliveryRouter` is not null. */
  readonly rewardAddress: Address | null;
  readonly wrappedNative: Address;
  /** The token factory of the destination chain. It names the copy that a first transfer of a native token deploys. Null when unknown. */
  readonly tokenFactory: Address | null;
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
  | "prerequisite-not-approved"
  | "prerequisite-gas-above-approval"
  | "prerequisites-not-satisfied"
  | "simulation-reverted"
  | "insufficient-gas"
  | "anchor-not-stored"
  | "batch-did-not-settle";

/** The result for one item. The runner writes it to the log and the outcome file. */
export type DeliveryOutcome =
  | {
      readonly status: "delivered";
      readonly messageId: Hex;
      readonly path: "delivery-router" | "bridge";
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
      /** `transaction-reverted`: the whole transaction failed. `batch-result-missing`: it succeeded, but the bridge reports no execution of the item. */
      readonly reason: "transaction-reverted" | "batch-result-missing";
      readonly transactionHash: Hex;
      readonly prerequisiteCostWei?: bigint;
    };

/** Whether the runner should never look at the item again. */
export function isFinal(outcome: DeliveryOutcome): boolean {
  if (outcome.status === "delivered") return true;
  return outcome.status === "skipped" && outcome.reason === "already-delivered";
}

/** A skipped item. */
export type Skip = Extract<DeliveryOutcome, { status: "skipped" }>;

/** Makes a skip. */
export function skip(messageId: Hex, reason: SkipReason, extra: Partial<Omit<Skip, "status" | "messageId" | "reason">> = {}): Skip {
  return { status: "skipped", messageId, reason, ...extra };
}

/** The proof of one message, as `MessageBridge.executeMessage` and the delivery router take it. */
export type MessageProof = ContractFunctionArgs<typeof messageBridgeAbi, "nonpayable", "executeMessage">[0];

/** Reads the proof out of the call data of the evidence. */
function proofOf(evidence: EvidencePackage): MessageProof {
  const decoded = decodeFunctionData({ abi: messageBridgeAbi, data: evidence.execute.data as Hex });
  if (decoded.functionName !== "executeMessage") throw new Error(`the evidence calls ${decoded.functionName}, not executeMessage`);
  return decoded.args[0];
}

/**
 * The call data of the entry of the delivery router: `executeMessage(proof)`. Any account may send it, because the router
 * pays the tip to its own reward address. The batch simulation uses it to measure the gas of one item.
 */
export function singleCallData(proof: MessageProof): Hex {
  return encodeFunctionData({ abi: deliveryRouterAbi, functionName: "executeMessage", args: [proof] });
}

/**
 * Names the destination token of a transfer that locks a native token and has none yet. The indexer learns the copy only
 * when a delivery registers it, so before the first transfer of a token its feed shows null. The runner needs the token to
 * price the tip, so it asks the token factory of the destination chain for the address that the copy gets (the factory
 * predicts it, and the copy has the decimals of its home token). A transfer that burns a copy has its native token named
 * already, and an item with no factory known stays as it is: the fee check then skips it with a reason.
 */
export async function withDestinationToken(dependencies: DeliveryDependencies, item: FeedItem): Promise<FeedItem> {
  const { transfer } = item;
  if (transfer === null || transfer.destinationToken !== null) return item;
  if (dependencies.tokenFactory === null || transfer.sourceIsNative !== true) return item;
  const answer = await dependencies.chain.call({
    to: dependencies.tokenFactory,
    data: encodeFunctionData({ abi: tokenFactoryAbi, functionName: "predictAddress", args: [BigInt(item.direction.sourceChainId), transfer.sourceToken.address as Address] }),
  });
  const address = decodeFunctionResult({ abi: tokenFactoryAbi, functionName: "predictAddress", data: answer });
  const destinationToken = { chainId: item.direction.destinationChainId, address, symbol: `zkb${transfer.sourceToken.symbol}`, decimals: transfer.sourceToken.decimals };
  return { ...item, transfer: { ...transfer, destinationToken } };
}

/**
 * The fee that the router would pay to its reward address for this gas, measured in wei. `payout` tells how the router pays it.
 * When the offer carries a user call, the router counts the gas of the call too (see {@link feeGasUnitsOf}): `plannedGas` is
 * the gas limit that the runner plans to send, which bounds that gas.
 */
export async function quoteFee(
  dependencies: DeliveryDependencies,
  item: FeedItem,
  offer: Extract<FeeOffer, { kind: "offer" }>,
  gasUnits: bigint,
  plannedGas: bigint,
): Promise<{ readonly ok: true; readonly feeWei: bigint; readonly feeTokens: bigint; readonly payout: PayoutKind } | { readonly ok: false; readonly reason: "no-price-for-fee-token" }> {
  const token = item.transfer?.destinationToken;
  if (token === undefined || token === null) return { ok: false, reason: "no-price-for-fee-token" };
  const { director } = offer;
  const payout = payoutOfOffer({ director, token: token.address as Address, wrappedNative: dependencies.wrappedNative });
  const data = encodeFunctionData({
    abi: deliveryRouterAbi,
    functionName: "feeInfo",
    args: [token.address as Address, offer.value, feeGasUnitsOf({ call: offer.call, executionGas: gasUnits, plannedGas, payout }), director],
  });
  const answer = await dependencies.chain.call({ to: dependencies.deliveryRouter as Address, data });
  const [feeTokens] = decodeFunctionResult({ abi: deliveryRouterAbi, functionName: "feeInfo", data: answer });
  const value = valueFeeInWei({
    fee: feeTokens,
    token: token.address as Address,
    decimals: token.decimals,
    director,
    wrappedNative: dependencies.wrappedNative,
    valuationsWei: dependencies.settings.tokenValuationsWei,
  });
  return value.ok ? { ok: true, feeWei: value.wei, feeTokens, payout } : value;
}

/** Sums the transfers of `token` to `account` in a list of logs. */
export function tokensReceived(logs: readonly ReceiptLog[], token: Address, account: Address): bigint {
  let total = 0n;
  for (const log of logs) {
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

/** A layout call that the estimate approved, with the gas that the estimate assumed for it. */
interface ApprovedPrerequisite {
  readonly to: Address;
  readonly data: Hex;
  readonly function: string;
  /** The simulated gas, or the fallback for a call that could not be simulated yet. The send may not need more. */
  readonly gas: bigint;
}

/** The result of {@link estimatePrerequisites}. */
type PrerequisiteEstimate =
  | { readonly ok: true; readonly gasUnits: bigint; readonly approved: readonly ApprovedPrerequisite[] }
  | { readonly ok: false; readonly outcome: Skip };

/**
 * Estimates the gas of every layout call that the evidence lists, and sends none. The first call can be simulated now.
 * A later call may depend on the call before it, so a revert there is no proof of a fault: the configured fallback
 * stands in for it. The calls of one function are alternatives, so the sum is an upper bound.
 * The calls and the gas of the result are the approved set: the sends may use no other call and no more gas.
 */
async function estimatePrerequisites(dependencies: DeliveryDependencies, messageId: Hex, evidence: EvidencePackage): Promise<PrerequisiteEstimate> {
  const { settings, chain } = dependencies;
  const listed = evidence.prerequisites.slice(0, settings.maximumPrerequisiteRounds);
  const approved: ApprovedPrerequisite[] = [];
  for (const [index, prerequisite] of listed.entries()) {
    const call = { to: prerequisite.to as Address, data: prerequisite.data as Hex };
    const simulation = await chain.simulate(call);
    if (!simulation.ok && index === 0) {
      return { ok: false, outcome: skip(messageId, "prerequisite-reverted", { detail: `${prerequisite.function}: ${simulation.reason}` }) };
    }
    approved.push({ ...call, function: prerequisite.function, gas: simulation.ok ? simulation.gas : settings.prerequisiteGasFallback });
  }
  return { ok: true, approved, gasUnits: approved.reduce((sum, entry) => sum + entry.gas, 0n) };
}

/** The most wei that the approved calls can cost when each is sent at the terms of `quote`. */
function worstCaseSpendWei(approved: readonly ApprovedPrerequisite[], quote: FeeQuote): bigint {
  return approved.reduce((sum, entry) => sum + worstCaseCostWei(sendTerms(quote, entry.gas)), 0n);
}

function sameCall(left: { readonly to: string; readonly data: string }, right: { readonly to: string; readonly data: string }): boolean {
  return left.to.toLowerCase() === right.to.toLowerCase() && left.data.toLowerCase() === right.data.toLowerCase();
}

/** The result of {@link satisfyPrerequisites}. The cost is what the calls cost, also when the result is a skip. */
type PrerequisiteResult =
  | { readonly ok: true; readonly evidence: EvidencePackage; readonly costWei: bigint }
  | { readonly ok: false; readonly outcome: Skip; readonly costWei: bigint };

/**
 * Sends the layout calls that the evidence lists, one at a time. After each call the evidence is built again, because
 * the calls of one function are alternatives: the next build lists none of them once a row covers the slot.
 *
 * Before each send the runner checks, in this order, that
 *
 * 1. the call is in the approved set, and not sent yet;
 * 2. the simulation succeeds and wants no more gas than the estimate assumed;
 * 3. the worst case of the send (gas limit times maximum fee per gas) fits the sweep cap, the daily budget and the loss
 *    threshold. The ledger charges that worst case before the call leaves, and settles to the actual cost at the receipt.
 *
 * A send that throws never settles. The reservation stays charged, because the transaction may be in the pool.
 */
async function satisfyPrerequisites(
  dependencies: DeliveryDependencies,
  ledger: PrerequisiteLedger,
  request: { readonly messageId: Hex; readonly transactionHash: Hex; readonly logIndex: number },
  first: EvidencePackage,
  approved: readonly ApprovedPrerequisite[],
): Promise<PrerequisiteResult> {
  let evidence = first;
  let costWei = 0n;
  const unsent = [...approved];
  const sent: Prerequisite[] = [];
  for (let round = 0; round < dependencies.settings.maximumPrerequisiteRounds; round += 1) {
    if (evidence.prerequisites.length === 0) return { ok: true, evidence, costWei };
    // The calls of one function are alternatives, and the prover lists every one that could add the row until a row covers
    // the slot. A call that was sent and did not cover it stays on the list, so the next call to send is the first listed
    // one that has not been sent. A list of sent calls only means that none of them was enough.
    const next: Prerequisite | undefined = evidence.prerequisites.find((candidate) => !sent.some((done) => sameCall(done, candidate)));
    if (next === undefined) return { ok: false, costWei, outcome: skip(request.messageId, "prerequisites-not-satisfied", { detail: `${evidence.prerequisites.length} calls remain and each was sent already` }) };
    const call = { to: next.to as Address, data: next.data as Hex };
    const approvedIndex = unsent.findIndex((entry) => sameCall(entry, call));
    const approval = unsent[approvedIndex];
    if (approval === undefined) return { ok: false, costWei, outcome: skip(request.messageId, "prerequisite-not-approved", { detail: `${next.function} was not in the approved estimate` }) };
    unsent.splice(approvedIndex, 1);
    const simulation = await dependencies.chain.simulate(call);
    if (!simulation.ok) return { ok: false, costWei, outcome: skip(request.messageId, "prerequisite-reverted", { detail: `${next.function}: ${simulation.reason}` }) };
    if (simulation.gas > approval.gas) {
      return { ok: false, costWei, outcome: skip(request.messageId, "prerequisite-gas-above-approval", { detail: `${next.function} now needs ${simulation.gas} gas, the estimate approved ${approval.gas}` }) };
    }
    const terms = sendTerms(await dependencies.chain.feeQuote(), approval.gas);
    const reserved = await ledger.reserve(worstCaseCostWei(terms));
    if (!reserved.ok) return { ok: false, costWei, outcome: skip(request.messageId, "prerequisite-budget-exhausted", { detail: reserved.detail }) };
    const receipt = await dependencies.chain.send({ ...call, ...terms });
    const callCostWei = receipt.gasUsed * receipt.effectiveGasPrice;
    await ledger.settle(reserved.reservation, callCostWei);
    costWei += callCostWei;
    sent.push(next);
    if (!receipt.success) return { ok: false, costWei, outcome: skip(request.messageId, "prerequisite-failed", { detail: `${next.function} in ${receipt.hash}` }) };
    dependencies.logger.info("prerequisite_sent", { messageId: request.messageId, function: next.function, transactionHash: receipt.hash, gasUsed: receipt.gasUsed });
    evidence = await dependencies.prover.evidence({ direction: dependencies.direction, transactionHash: request.transactionHash, logIndex: request.logIndex });
    if (evidence.alreadyDelivered) return { ok: false, costWei, outcome: skip(request.messageId, "already-delivered") };
  }
  if (evidence.prerequisites.length === 0) return { ok: true, evidence, costWei };
  return { ok: false, costWei, outcome: skip(request.messageId, "prerequisites-not-satisfied", { detail: `${evidence.prerequisites.length} calls remain` }) };
}

/**
 * Marks a skip with the wei that layout calls cost before it, logs the loss and adds it to the unrecovered loss of the ledger. A skip with no spend stays as it is.
 */
export async function recordLoss(dependencies: DeliveryDependencies, ledger: PrerequisiteLedger, outcome: Skip, spentWei: bigint): Promise<Skip> {
  if (spentWei === 0n) return outcome;
  dependencies.logger.warn("prerequisite_loss", { messageId: outcome.messageId, lossWei: spentWei, reason: outcome.reason });
  await ledger.recordLoss(spentWei);
  return { ...outcome, prerequisiteCostWei: spentWei };
}

/** The gas the runner assumes before it can simulate: the layout calls and one execution. */
function guessGas(settings: DeliverySettings): bigint {
  return settings.executionGasFallback;
}

/** The result of {@link approvePrerequisiteSpend}: the approved calls, a skip, or nothing to approve. */
type Approval = { readonly kind: "skip"; readonly outcome: Skip } | { readonly kind: "approved"; readonly approved: readonly ApprovedPrerequisite[] };

/**
 * Checks, before any layout call leaves, that the offer repays the layout calls and the execution together, and that
 * the budgets have room for the worst case of the layout calls. The estimate and each later reservation use the same
 * maximum fee per gas. Does nothing when the evidence lists no layout call, so an item that needs none is never paused.
 * Returns the approved set, or the skip.
 */
async function approvePrerequisiteSpend(
  dependencies: DeliveryDependencies,
  ledger: PrerequisiteLedger,
  context: { readonly item: FeedItem; readonly offer: FeeOffer; readonly evidence: EvidencePackage; readonly messageId: Hex },
): Promise<Approval> {
  const { item, offer, evidence, messageId } = context;
  const { settings, chain } = dependencies;
  if (evidence.prerequisites.length === 0) return { kind: "approved", approved: [] };
  const estimate = await estimatePrerequisites(dependencies, messageId, evidence);
  if (!estimate.ok) return { kind: "skip", outcome: estimate.outcome };
  const quote = await chain.feeQuote();
  const worstCaseWei = worstCaseSpendWei(estimate.approved, quote);
  const refusal = await ledger.refusal(worstCaseWei);
  if (refusal !== null) return { kind: "skip", outcome: skip(messageId, "prerequisite-budget-exhausted", { costWei: worstCaseWei, detail: refusal }) };
  if (offer.kind !== "offer") return { kind: "approved", approved: estimate.approved };
  const judgement = await judgeOffer(dependencies, {
    item,
    offer,
    feeGasUnits: guessGas(settings),
    costGasUnits: estimate.gasUnits + guessGas(settings),
    quote,
    messageId,
  });
  return judgement.kind === "skip" ? { kind: "skip", outcome: judgement.outcome } : { kind: "approved", approved: estimate.approved };
}

/** An item that passed every per-item step and waits for a batch. */
export interface ReadyDelivery {
  readonly item: FeedItem;
  readonly messageId: Hex;
  readonly offer: Extract<FeeOffer, { kind: "offer" }>;
  /** The proof tuple that the evidence carries, after the layout calls. */
  readonly proof: MessageProof;
  /** The gas the runner assumes for the item before a simulation: `executionGasFallback`. The batch planner sums it. */
  readonly assumedGas: bigint;
  /** What the layout calls for this item cost. Zero when it needed none. */
  readonly prerequisiteCostWei: bigint;
}

/** The result of {@link prepareItem}: a final outcome, or an item that waits for a batch. */
export type Preparation = { readonly kind: "outcome"; readonly outcome: DeliveryOutcome } | { readonly kind: "ready"; readonly ready: ReadyDelivery };

/**
 * Does the per-item work of a delivery, up to and including the layout calls.
 *
 * 1. Read the call data of the message from the indexer and look for a fee offer to the delivery router.
 * 2. Price the offer at the assumed gas, and skip when the fee does not cover cost and margin. This check needs no
 *    evidence, so an item that does not pay costs no proving time.
 * 3. Build the evidence (`zk-bridge-prover evidence`). Skip when the message is delivered already.
 * 4. Estimate the gas of every layout call. Require that the fee covers the layout calls and the execution together, plus
 *    the margin, and that the worst case of the layout calls fits the budgets. Skip before any layout call leaves.
 *    The calls and the gas of this estimate are the approved set.
 * 5. Send the layout calls that the evidence lists, each after a simulation, each inside the approved set, and each
 *    after the ledger reserved its worst case.
 *
 * An item with a fee offer then returns as a {@link ReadyDelivery}. {@link sendBatch} simulates the batch, judges the fee
 * again at the simulated gas, and sends. An item without an offer (when the configuration delivers such items) goes
 * straight to the bridge here, with its own simulation. Wei spent on layout calls is lost when the item is then not
 * delivered: the skip carries the amount and the runner does not retry the item soon.
 */
export async function prepareItem(dependencies: DeliveryDependencies, listed: FeedItem, ledger: PrerequisiteLedger): Promise<Preparation> {
  const item = await withDestinationToken(dependencies, listed);
  const messageId = item.messageId as Hex;
  const { settings, chain } = dependencies;
  const done = (outcome: DeliveryOutcome): Preparation => ({ kind: "outcome", outcome });
  const message = await dependencies.indexer.getMessage(item.messageId);
  const offer = readFeeOffer({ messageData: message.data as Hex, deliveryRouter: dependencies.deliveryRouter });
  if (offer.kind === "none" && !settings.deliverWithoutOffer) return done(skip(messageId, "no-fee-offer", { detail: offer.reason }));

  const quote = await chain.feeQuote();
  const early =
    offer.kind === "offer"
      ? await judgeOffer(dependencies, { item, offer, feeGasUnits: guessGas(settings), costGasUnits: guessGas(settings), quote, messageId })
      : null;
  if (early !== null && early.kind === "skip") return done(early.outcome);

  const sourceTransaction = item.sent?.transactionHash as Hex | undefined;
  if (sourceTransaction === undefined) return done(skip(messageId, "source-log-not-found", { detail: "the indexer has no send" }));
  const logIndex = await dependencies.source.findMessageLogIndex({ transactionHash: sourceTransaction, messageId });
  if (logIndex === null) return done(skip(messageId, "source-log-not-found"));

  let evidence: EvidencePackage;
  try {
    evidence = await dependencies.prover.evidence({ direction: dependencies.direction, transactionHash: sourceTransaction, logIndex });
  } catch (error) {
    return done(skip(messageId, "evidence-failed", { detail: error instanceof Error ? error.message : String(error) }));
  }
  if (evidence.alreadyDelivered) return done(skip(messageId, "already-delivered", { detail: evidence.deliveryStatus }));

  const approval = await approvePrerequisiteSpend(dependencies, ledger, { item, offer, evidence, messageId });
  if (approval.kind === "skip") return done(approval.outcome);

  const prepared = await satisfyPrerequisites(dependencies, ledger, { messageId, transactionHash: sourceTransaction, logIndex }, evidence, approval.approved);
  if (!prepared.ok) return done(await recordLoss(dependencies, ledger, prepared.outcome, prepared.costWei));

  if (offer.kind === "none") return done(await deliverDirect(dependencies, ledger, { item, messageId, evidence: prepared.evidence, prerequisiteCostWei: prepared.costWei }));
  return {
    kind: "ready",
    ready: { item, messageId, offer, proof: proofOf(prepared.evidence), assumedGas: guessGas(settings), prerequisiteCostWei: prepared.costWei },
  };
}

/** Input of {@link deliverDirect}. */
interface DirectDeliveryInput {
  readonly item: FeedItem;
  readonly messageId: Hex;
  readonly evidence: EvidencePackage;
  readonly prerequisiteCostWei: bigint;
}

/**
 * Delivers an item that has no fee offer: the evidence call data goes to the bridge, after a simulation that succeeded.
 * There is no fee to judge, so the configuration (`deliverWithoutOffer`) is the decision.
 */
async function deliverDirect(dependencies: DeliveryDependencies, ledger: PrerequisiteLedger, input: DirectDeliveryInput): Promise<DeliveryOutcome> {
  const { messageId, evidence, prerequisiteCostWei } = input;
  const { chain, logger } = dependencies;
  const call = { to: evidence.execute.to as Address, data: evidence.execute.data as Hex };
  const simulation = await chain.simulate(call);
  if (!simulation.ok) return recordLoss(dependencies, ledger, skip(messageId, "simulation-reverted", { detail: simulation.reason }), prerequisiteCostWei);
  const receipt = await chain.send({ ...call, ...sendTerms(await chain.feeQuote(), simulation.gas) });
  if (!receipt.success) {
    await ledger.recordLoss(prerequisiteCostWei);
    return { status: "failed", messageId, reason: "transaction-reverted", transactionHash: receipt.hash, ...(prerequisiteCostWei > 0n ? { prerequisiteCostWei } : {}) };
  }
  logger.info("delivery_sent", { messageId, path: "bridge", transactionHash: receipt.hash, gasUsed: receipt.gasUsed });
  return {
    status: "delivered",
    messageId,
    path: "bridge",
    transactionHash: receipt.hash,
    gasUsed: receipt.gasUsed,
    gasCostWei: receipt.gasUsed * receipt.effectiveGasPrice,
    prerequisiteCostWei,
    feeExpectedWei: null,
    feeReceivedTokens: null,
  };
}

export type Judgement = { readonly kind: "pay"; readonly feeWei: bigint } | { readonly kind: "skip"; readonly outcome: Skip };

/** Input of {@link judgeOffer}. */
export interface JudgeOfferInput {
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
export async function judgeOffer(dependencies: DeliveryDependencies, input: JudgeOfferInput): Promise<Judgement> {
  const { item, offer, feeGasUnits, costGasUnits, quote, messageId } = input;
  const priced = await quoteFee(dependencies, item, offer, feeGasUnits, sendTerms(quote, feeGasUnits).gas);
  if (!priced.ok) return { kind: "skip", outcome: skip(messageId, priced.reason) };
  const decision = decideDelivery({ feeWei: priced.feeWei, gasUnits: costGasUnits, quote, minimumMarginWei: dependencies.settings.minimumMarginWei });
  if (decision.deliver) return { kind: "pay", feeWei: priced.feeWei };
  return {
    kind: "skip",
    outcome: skip(messageId, "fee-below-cost-plus-margin", {
      feeWei: priced.feeWei,
      costWei: decision.costWei,
      detail: `short by ${decision.shortfallWei} wei at ${costGasUnits} gas, tip paid as ${priced.payout}`,
    }),
  };
}
