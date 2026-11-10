import { decodeEventLog, decodeFunctionData, decodeFunctionResult, encodeFunctionData, erc20Abi, keccak256, type Address, type ContractFunctionArgs, type Hex } from "viem";
import { DEFAULT_CAP_WAD, PERCENT_WAD, bridgedSymbolOf, decodeMediatorMessage, deliveryRouterAbi, feeValueOf, messageBridgeAbi, tipPays, tipVerdict, tokenFactoryAbi, type PayoutKind, type ProofDirection, type TipVerdict, type TokenValuation } from "@zk-bridge/shared";
import { sendTerms, worstCaseCostWei, type FeeQuote, type ReceiptLog, type TransactionPort } from "../chain/transactions.ts";
import type { FeedItem, IndexerClient } from "../indexer/client.ts";
import type { Logger } from "../logging/logger.ts";
import type { EvidencePackage, Prerequisite, ProverBinary } from "@zk-bridge/shared/prover";
import type { PrerequisiteLedger } from "./prerequisite-ledger.ts";
import { feeGasUnitsOf, payoutOfOffer, readFeeOffer, type FeeOffer } from "./fee.ts";
import type { TokenPricing } from "./pricing.ts";
import type { SourceReader } from "./source-reader.ts";

/** The settings of a delivery that come from the bot configuration. */
export interface DeliverySettings {
  /**
   * The share of its cost that the runner accepts to lose on one delivery, from 0 to 100. A loss at this share or above
   * leaves the item out. It judges a priced tip (the `loss` rule of `tipVerdict`); an unpriced tip is judged by the
   * automatic maximum instead.
   */
  readonly maximumLossPercent: number;
  /**
   * Deliver whatever the tip, priced or not: the delayed unpaid rule sets it for the items that waited long enough.
   * Absent: false.
   */
  readonly deliverAnyTip?: boolean;
  readonly deliverWithoutOffer: boolean;
  /** Seconds after which a covered item is delivered at a loss or with no offer. Null or absent: never. */
  readonly deliverUnpaidAfterSeconds?: number | null;
  /** The most wei that those deliveries cost in 24 hours on this chain. Null or absent: none is sent. */
  readonly maximumUnpaidSpendPerDayWei?: bigint | null;
  /**
   * The gas the runner assumes for one whole delivery (proof check, bridge, mediator, router) when it cannot estimate it
   * yet: the first fee check runs before the evidence exists, and a delivery that needs a light client update in the same
   * batch cannot be estimated alone. Once an estimate exists, it replaces this number.
   */
  readonly deliveryGasFallback: bigint;
  readonly maximumPrerequisiteRounds: number;
  /** The gas the runner assumes for a layout call that it cannot simulate before the call before it is mined. */
  readonly prerequisiteGasFallback: bigint;
  /** The most wei that the layout calls of one sweep may cost. */
  readonly maximumPrerequisiteSpendPerSweepWei: bigint;
  /** The most wei that layout calls may cost, reservations included, in a rolling 24 hours. The state file keeps it. */
  readonly maximumPrerequisiteSpendPerDayWei: bigint;
  /** The unrecovered loss of a rolling 24 hours at which the runner stops sending layout calls. */
  readonly maximumUnrecoveredPrerequisiteLossWei: bigint;
  /**
   * The tries of one message that may spend on layout calls and end with the message still uncovered. At this count the
   * runner sends no more layout calls for the message (skip `prerequisites-stuck`). Absent: {@link DEFAULT_MAXIMUM_UNSATISFIED_PREREQUISITE_ATTEMPTS}.
   */
  readonly maximumUnsatisfiedPrerequisiteAttempts?: number;
  /** The most items that one batch transaction delivers. */
  readonly maximumBatchSize: number;
  /** The most gas that one batch may use: the sum of the estimates of its items and of the block proof update. A single item above it goes alone. */
  readonly maximumBatchGas: bigint;
}

/** The parts a delivery touches. Tests pass fakes for every one. */
export interface DeliveryDependencies {
  readonly direction: ProofDirection;
  /** The chain that the messages leave, from the configuration. The destination is `chain.chainId`. */
  readonly sourceChainId: number;
  readonly chain: TransactionPort;
  readonly prover: ProverBinary;
  readonly indexer: IndexerClient;
  readonly source: SourceReader;
  /**
   * The delivery router of the destination chain, or null. The runner delivers to the router that the operator names
   * here and to no other. This is the operator's allowlist, not a rule of the protocol: no contract of the bridge or the
   * mediator knows a router, and anyone may deploy one.
   */
  readonly deliveryRouter: Address | null;
  /** The Multicall3 contract of the destination chain, which batches the calls of a delivery. Not null whenever `deliveryRouter` is not null. */
  readonly multicall: Address | null;
  /** The address that receives the tips, read from the router at start up. It serves the accounting and the log. Not null whenever `deliveryRouter` is not null. */
  readonly rewardAddress: Address | null;
  readonly wrappedNative: Address;
  /**
   * The message bridge of the destination chain. The runner believes an `AffirmationCompleted` event of a batch only
   * from this address: the target of a message runs inside the batch and can write an event of the same shape.
   */
  readonly bridge: Address;
  /** The token factory of the destination chain. It names the copy that a first transfer of a native token deploys. Null when unknown. */
  readonly tokenFactory: Address | null;
  readonly settings: DeliverySettings;
  /**
   * Values a fee token: the one price source of zkb.fi (PulseX pools through the runner's PulseChain RPC, with the
   * dapp's stale rule). A token with no market price is judged by the automatic maximum.
   */
  readonly pricing: TokenPricing;
  readonly logger: Logger;
}

/** Why the runner did not deliver an item. */
export type SkipReason =
  | "no-fee-offer"
  | "unpaid-spend-cap"
  | "no-price-for-fee-token"
  | "loss-at-or-above-limit"
  | "unpriced-tip-below-maximum"
  | "message-gas-above-batch-maximum"
  | "batch-gas-above-maximum"
  | "source-log-not-found"
  | "already-delivered"
  | "indexer-disagrees-with-evidence"
  | "evidence-for-another-message"
  | "wrong-direction"
  | "evidence-failed"
  | "fee-quote-failed"
  | "prerequisite-reverted"
  | "prerequisite-failed"
  | "prerequisite-budget-exhausted"
  | "prerequisite-not-approved"
  | "prerequisite-gas-above-approval"
  | "prerequisites-not-satisfied"
  | "prerequisites-stuck"
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
      /** The fee that `feeInfo` promised at the last simulation, in wei. Null when the item had no offer, or its token no price. */
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
    data: encodeFunctionData({ abi: tokenFactoryAbi, functionName: "predictAddress", args: [BigInt(dependencies.sourceChainId), transfer.sourceToken.address as Address] }),
  });
  const address = decodeFunctionResult({ abi: tokenFactoryAbi, functionName: "predictAddress", data: answer });
  const destinationToken = { chainId: dependencies.chain.chainId, address, symbol: bridgedSymbolOf(transfer.sourceToken.symbol), decimals: transfer.sourceToken.decimals };
  return { ...item, transfer: { ...transfer, destinationToken } };
}

/** What {@link quoteFee} finds: the tip in tokens, how it is paid, the token's decimals and its valuation. */
export type FeeQuoteResult =
  | { readonly ok: true; readonly feeTokens: bigint; readonly payout: PayoutKind; readonly decimals: number; readonly valuation: TokenValuation }
  | { readonly ok: false; readonly reason: "no-price-for-fee-token" };

/** The valuation of a token whose decimals cannot be read: no price can be derived. */
const UNVALUED: TokenValuation = { state: { kind: "unreachable" }, usdE18: null, nativeUsdE18: null, weiPerToken: null };

/**
 * The fee that the router would pay to its reward address for this gas, in tokens, with the token's valuation from the
 * one price source. `payout` tells how the router pays it. When the offer carries a user call, the router counts the
 * `callGas` of the director too (see {@link feeGasUnitsOf}). A token whose decimals cannot be read is not valued (its tip
 * is judged by the automatic maximum, which needs no price).
 */
export async function quoteFee(dependencies: DeliveryDependencies, item: FeedItem, offer: Extract<FeeOffer, { kind: "offer" }>, gasUnits: bigint): Promise<FeeQuoteResult> {
  const token = item.transfer?.destinationToken;
  if (token === undefined || token === null) return { ok: false, reason: "no-price-for-fee-token" };
  const { director } = offer;
  const payout = payoutOfOffer({ director, token: token.address as Address, wrappedNative: dependencies.wrappedNative });
  const data = encodeFunctionData({
    abi: deliveryRouterAbi,
    functionName: "feeInfo",
    args: [token.address as Address, offer.value, feeGasUnitsOf({ call: offer.call, executionGas: gasUnits, callGas: director.callGas }), director],
  });
  const answer = await dependencies.chain.call({ to: dependencies.deliveryRouter as Address, data });
  const [feeTokens] = decodeFunctionResult({ abi: deliveryRouterAbi, functionName: "feeInfo", data: answer });
  // A send that locks a native token releases a copy, which the token factory deploys with the decimals of its home
  // token. Before the first delivery the copy has no code and cannot answer, so those decimals stand in for it.
  const transfer = item.transfer as NonNullable<FeedItem["transfer"]>;
  const decimals = (await tokenDecimals(dependencies, token.address as Address)) ?? (transfer.sourceIsNative === true ? transfer.sourceToken.decimals : null);
  if (decimals === null) return { ok: true, feeTokens, payout, decimals: 0, valuation: UNVALUED };
  // A copy that zkb.fi minted takes the price of its home token on the source chain.
  const origin = transfer.sourceIsNative === true ? { chainId: item.direction.sourceChainId, address: transfer.sourceToken.address as Address } : null;
  const valuation = await dependencies.pricing({ address: token.address as Address, decimals, origin });
  return { ok: true, feeTokens, payout, decimals, valuation };
}

/**
 * The token that the mediator releases to the router for a token message: the named token when it is native on the
 * destination, else the copy that the token factory names for the token of the source chain (the mediator deploys
 * every copy through the factory). Null when the deployment names no token factory.
 */
async function releasedTokenOf(dependencies: DeliveryDependencies, item: FeedItem, data: Hex): Promise<Address | null> {
  // readFeeOffer found an offer, so the data is a mediator message.
  const message = decodeMediatorMessage(data)!;
  if (message.releasesNativeToken) return message.token;
  if (dependencies.tokenFactory === null) return null;
  const answer = await dependencies.chain.call({
    to: dependencies.tokenFactory,
    data: encodeFunctionData({ abi: tokenFactoryAbi, functionName: "predictAddress", args: [BigInt(dependencies.sourceChainId), message.token] }),
  });
  return decodeFunctionResult({ abi: tokenFactoryAbi, functionName: "predictAddress", data: answer });
}

/**
 * The decimals of a fee token, read from the token on the destination chain: the indexer's word is not trusted, and a
 * wrong value would scale the tip by a power of ten. The wrapped native token has the native coin's 18 and is not asked.
 * Null when the token does not answer, as a copy that is not deployed yet: the runner then cannot value the tip.
 */
async function tokenDecimals(dependencies: DeliveryDependencies, token: Address): Promise<number | null> {
  if (token.toLowerCase() === dependencies.wrappedNative.toLowerCase()) return 18;
  try {
    const answer = await dependencies.chain.call({ to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "decimals" }) });
    return decodeFunctionResult({ abi: erc20Abi, functionName: "decimals", data: answer });
  } catch {
    return null;
  }
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

/** The tries of one message that may end with layout spend and no covering row, when the settings name no number. */
export const DEFAULT_MAXIMUM_UNSATISFIED_PREREQUISITE_ATTEMPTS = 3;

/** The key of a layout call in the runner state: keccak256 of its target and its call data, lowercase. */
export function prerequisiteCallKey(call: { readonly to: string; readonly data: string }): Hex {
  return keccak256(`0x${call.to.slice(2).toLowerCase()}${call.data.slice(2).toLowerCase()}`);
}

/**
 * What earlier tries did with the layout calls of one message. The runner keeps it in its state file. Without it a try
 * starts from nothing, as one did before the state kept it.
 */
export interface PrerequisiteHistory {
  /** The keys ({@link prerequisiteCallKey}) of the calls that were mined for the message and did not cover it. */
  readonly sentCalls: ReadonlySet<string>;
  /** The earlier tries that spent on layout calls and ended with the message still uncovered. */
  readonly unsatisfiedAttempts: number;
  /** Stores the key of a call that was just mined, before the evidence is built again. */
  recordSent(key: Hex): Promise<void>;
}

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
  history: PrerequisiteHistory | undefined,
): Promise<PrerequisiteResult> {
  let evidence = first;
  let costWei = 0n;
  const unsent = [...approved];
  // The calls sent by earlier tries count as sent: the same call adds the same row, which did not cover the message.
  const sent = new Set<string>(history?.sentCalls ?? []);
  for (let round = 0; round < dependencies.settings.maximumPrerequisiteRounds; round += 1) {
    if (evidence.prerequisites.length === 0) return { ok: true, evidence, costWei };
    // The calls of one function are alternatives, and the prover lists every one that could add the row until a row covers
    // the slot. A call that was sent and did not cover it stays on the list, so the next call to send is the first listed
    // one that has not been sent. A list of sent calls only means that none of them was enough.
    const next: Prerequisite | undefined = evidence.prerequisites.find((candidate) => !sent.has(prerequisiteCallKey(candidate)));
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
    sent.add(prerequisiteCallKey(next));
    if (!receipt.success) return { ok: false, costWei, outcome: skip(request.messageId, "prerequisite-failed", { detail: `${next.function} in ${receipt.hash}` }) };
    dependencies.logger.info("prerequisite_sent", { messageId: request.messageId, function: next.function, transactionHash: receipt.hash, gasUsed: receipt.gasUsed });
    await history?.recordSent(prerequisiteCallKey(next));
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

/**
 * The gas that Multicall3 adds to each call, beyond the single entry of the router: the call, the copy of the proof and
 * the result. The batch test of the router (`DeliveryRouterBatching.t.sol`) measures about 17,000, so this rounds up. An
 * estimate of an item at the single entry gets it added, because the item then runs inside a batch.
 */
export const BATCH_ITEM_OVERHEAD_GAS = 20_000n;

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
  context: { readonly item: FeedItem; readonly offer: FeeOffer; readonly evidence: EvidencePackage; readonly messageId: Hex; readonly assumedGas: bigint },
): Promise<Approval> {
  const { item, offer, evidence, messageId, assumedGas } = context;
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
    feeGasUnits: assumedGas,
    costGasUnits: estimate.gasUnits + assumedGas,
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
  /**
   * The gas of the delivery inside a batch: the estimate of the delivery call plus {@link BATCH_ITEM_OVERHEAD_GAS}, or
   * the configured fallback when the call cannot be estimated alone. The batch planner sums it.
   */
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
 * 2. Price the offer at the configured fallback gas, and skip when the loss reaches the limit. This check needs no
 *    evidence, so an item that does not pay costs no proving time.
 * 3. Build the evidence (`zk-bridge-prover evidence`). Skip when the message is delivered already.
 * 4. Estimate the gas of every layout call. Require that the loss on the layout calls and the execution together stays under the limit, and that the worst case of the layout calls fits the budgets. Skip before any layout call leaves.
 *    The calls and the gas of this estimate are the approved set.
 * 5. Send the layout calls that the evidence lists, each after a simulation, each inside the approved set, and each
 *    after the ledger reserved its worst case.
 * 6. Estimate the delivery call (`eth_estimateGas` of `executeMessage` at the router). The estimate sizes the item in a
 *    batch. A delivery that reverts or runs out of gas leaves no trace on chain, so a call that cannot be estimated alone
 *    (it may need the light client update of the same batch) keeps the fallback, and the batch simulation decides.
 *
 * An item with a fee offer then returns as a {@link ReadyDelivery}. {@link sendBatch} simulates the batch, judges the fee
 * again at the simulated gas, and sends. An item without an offer (when the configuration delivers such items) goes
 * straight to the bridge here, with its own simulation. Wei spent on layout calls is lost when the item is then not
 * delivered: the skip carries the amount and the runner does not retry the item soon.
 */
export async function prepareItem(dependencies: DeliveryDependencies, listed: FeedItem, ledger: PrerequisiteLedger, history?: PrerequisiteHistory): Promise<Preparation> {
  // The chains of the item come from the indexer. An item of another direction is none of this runner's business, and
  // its chain ids must not steer the copy lookup.
  if (listed.direction.sourceChainId !== dependencies.sourceChainId || listed.direction.destinationChainId !== dependencies.chain.chainId) {
    return { kind: "outcome", outcome: skip(listed.messageId as Hex, "wrong-direction", { detail: `the indexer lists ${listed.direction.sourceChainId} to ${listed.direction.destinationChainId}` }) };
  }
  const item = await withDestinationToken(dependencies, listed);
  const messageId = item.messageId as Hex;
  const { settings, chain } = dependencies;
  const done = (outcome: DeliveryOutcome): Preparation => ({ kind: "outcome", outcome });
  const fallbackGas = settings.deliveryGasFallback;
  const message = await dependencies.indexer.getMessage(item.messageId);
  const offer = readFeeOffer({ messageData: message.data as Hex, deliveryRouter: dependencies.deliveryRouter });
  if (offer.kind === "none" && !settings.deliverWithoutOffer) return done(skip(messageId, "no-fee-offer", { detail: offer.reason }));
  // The tip is priced in the destination token of the feed item. It must be the token that the message releases to
  // the router. The message data itself is checked against the source chain once the evidence is built.
  // An item without a destination token is left to the fee check, which cannot price it.
  const listedToken = item.transfer?.destinationToken?.address;
  if (offer.kind === "offer" && listedToken !== undefined) {
    const released = await releasedTokenOf(dependencies, item, message.data as Hex);
    if (released === null) return done(skip(messageId, "no-price-for-fee-token"));
    if (released.toLowerCase() !== listedToken.toLowerCase()) {
      return done(skip(messageId, "indexer-disagrees-with-evidence", { detail: `the message releases ${released}` }));
    }
  }

  const quote = await chain.feeQuote();
  const early =
    offer.kind === "offer"
      ? await judgeOffer(dependencies, { item, offer, feeGasUnits: fallbackGas, costGasUnits: fallbackGas, quote, messageId })
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
  // A prover that answers for another message would deliver it and record it under this item.
  if (evidence.message.messageId.toLowerCase() !== messageId.toLowerCase()) {
    return done(skip(messageId, "evidence-for-another-message", { detail: `the evidence names ${evidence.message.messageId}` }));
  }
  if (evidence.alreadyDelivered) return done(skip(messageId, "already-delivered", { detail: evidence.deliveryStatus }));
  // The offer priced above comes from the indexer. The prover read the message from the source chain, so an indexer
  // that disagrees with it is lying or wrong, and the item is left before any gas is spent.
  if (evidence.message.data.toLowerCase() !== message.data.toLowerCase()) {
    return done(skip(messageId, "indexer-disagrees-with-evidence", { detail: "the data of the message differs from the source chain" }));
  }

  const unsent = refuseRepeatedPrerequisites(dependencies, { messageId, evidence, history });
  if (unsent.kind === "skip") return done(unsent.outcome);

  const approval = await approvePrerequisiteSpend(dependencies, ledger, { item, offer, evidence: unsent.evidence, messageId, assumedGas: fallbackGas });
  if (approval.kind === "skip") return done(approval.outcome);

  const prepared = await satisfyPrerequisites(dependencies, ledger, { messageId, transactionHash: sourceTransaction, logIndex }, unsent.evidence, approval.approved, history);
  if (!prepared.ok) return done(await recordLoss(dependencies, ledger, prepared.outcome, prepared.costWei));

  if (offer.kind === "none") return done(await deliverDirect(dependencies, ledger, { item, messageId, evidence: prepared.evidence, prerequisiteCostWei: prepared.costWei }));
  const proof = proofOf(prepared.evidence);
  const estimate = await chain.simulate({ to: dependencies.deliveryRouter as Address, data: singleCallData(proof) });
  const assumedGas = estimate.ok ? estimate.gas + BATCH_ITEM_OVERHEAD_GAS : fallbackGas;
  return { kind: "ready", ready: { item, messageId, offer, proof, assumedGas, prerequisiteCostWei: prepared.costWei } };
}

/**
 * Leaves out the layout calls that earlier tries sent for the message, and stops spending on a message whose tries
 * spent on layout calls too often without covering it. Before the state kept these, a call that adds a row which does
 * not cover the message was sent again on every try (message ...0000, 943 to Sepolia, 2026-11-08).
 */
function refuseRepeatedPrerequisites(
  dependencies: DeliveryDependencies,
  context: { readonly messageId: Hex; readonly evidence: EvidencePackage; readonly history: PrerequisiteHistory | undefined },
): { readonly kind: "skip"; readonly outcome: Skip } | { readonly kind: "unsent"; readonly evidence: EvidencePackage } {
  const { messageId, evidence, history } = context;
  if (history === undefined || evidence.prerequisites.length === 0) return { kind: "unsent", evidence };
  const maximum = dependencies.settings.maximumUnsatisfiedPrerequisiteAttempts ?? DEFAULT_MAXIMUM_UNSATISFIED_PREREQUISITE_ATTEMPTS;
  if (history.unsatisfiedAttempts >= maximum) {
    const detail = `${history.unsatisfiedAttempts} tries sent layout calls that did not cover the message; the runner sends no more for it. Remove its entry from prerequisiteAttempts in the runner state to try again`;
    dependencies.logger.warn("prerequisites_stuck", { messageId, unsatisfiedAttempts: history.unsatisfiedAttempts, listed: evidence.prerequisites.map((call) => call.function) });
    return { kind: "skip", outcome: skip(messageId, "prerequisites-stuck", { detail }) };
  }
  const prerequisites = evidence.prerequisites.filter((call) => !history.sentCalls.has(prerequisiteCallKey(call)));
  if (prerequisites.length === 0) {
    return { kind: "skip", outcome: skip(messageId, "prerequisites-not-satisfied", { detail: `each of the ${evidence.prerequisites.length} listed calls was sent by an earlier try and did not cover the message` }) };
  }
  return { kind: "unsent", evidence: { ...evidence, prerequisites } };
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

export type Judgement = { readonly kind: "pay"; readonly feeWei: bigint | null; readonly verdict: TipVerdict } | { readonly kind: "skip"; readonly outcome: Skip };

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

/**
 * Prices the offer at the fee gas and judges it with the one tip verdict of zkb.fi (`tipVerdict`), against the cost of
 * the cost gas in wei. A priced tip pays when the loss stays under `maximumLossPercent` of the cost; an unpriced tip (no
 * market, or no price can be read) pays when it is at least the frontend's automatic maximum, 1% of the amount, and is
 * then delivered straight away. Otherwise the item is left out (`loss-at-or-above-limit`, `unpriced-tip-below-maximum`),
 * and the delayed unpaid rule may still deliver it; that rule sets `deliverAnyTip`.
 */
export async function judgeOffer(dependencies: DeliveryDependencies, input: JudgeOfferInput): Promise<Judgement> {
  const { item, offer, feeGasUnits, costGasUnits, quote, messageId } = input;
  const { settings } = dependencies;
  const priced = await quoteFee(dependencies, item, offer, feeGasUnits);
  if (!priced.ok) return { kind: "skip", outcome: skip(messageId, priced.reason) };
  const costWei = costGasUnits * (quote.baseFee + quote.priorityFee);
  const price = { state: priced.valuation.state, perWholeToken: priced.valuation.weiPerToken };
  const verdict = tipVerdict({ amount: offer.value, fee: priced.feeTokens, decimals: priced.decimals, price, cost: costWei, rule: { kind: "loss", maximumLossPercent: settings.maximumLossPercent } });
  const feeWei = feeValueOf(priced.feeTokens, priced.decimals, price);
  if (tipPays(verdict) || settings.deliverAnyTip === true) return { kind: "pay", feeWei, verdict };
  if (verdict === "unpriced-below-max") {
    return {
      kind: "skip",
      outcome: skip(messageId, "unpriced-tip-below-maximum", {
        costWei,
        detail: `the token has no price (${priced.valuation.state.kind}), and the tip of ${priced.feeTokens} is under the automatic maximum of ${DEFAULT_CAP_WAD / PERCENT_WAD}% of ${offer.value}, tip paid as ${priced.payout}`,
      }),
    };
  }
  return {
    kind: "skip",
    outcome: skip(messageId, "loss-at-or-above-limit", {
      feeWei: feeWei as bigint,
      costWei,
      detail: `loses ${costWei - (feeWei as bigint)} wei of ${costWei} at ${costGasUnits} gas, the limit is ${settings.maximumLossPercent} percent, tip paid as ${priced.payout}`,
    }),
  };
}
