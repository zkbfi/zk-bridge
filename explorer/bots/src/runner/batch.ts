import { erc20Abi, decodeErrorResult, decodeEventLog, encodeFunctionData, type Abi, type Address, type Hex } from "viem";
import {
  beaconLightClientAbi,
  decodeAggregate3,
  encodeAggregate3,
  deliveryRouterAbi,
  messageBridgeAbi,
  type BatchedCall,
  type BatchedCallResult,
  type ProofMessage,
} from "@zk-bridge/shared";
import { sendTerms, worstCaseCostWei, type CallRequest, type FeeQuote, type ReceiptSummary, type SendTerms, type TransactionPort } from "../chain/transactions.ts";
import type { FeedItem } from "../indexer/client.ts";
import {
  judgeOffer,
  prepareItem,
  recordLoss,
  singleCallData,
  skip,
  tokensReceived,
  type DeliveryDependencies,
  type DeliveryOutcome,
  type Judgement,
  type ReadyDelivery,
  type Skip,
} from "./delivery.ts";
import type { PrerequisiteLedger } from "./prerequisite-ledger.ts";

/**
 * The gas that Multicall3 adds to each call, beyond the single entry of the router: the call, the copy of the proof and
 * the result. The batch test of the router (`DeliveryRouterBatching.t.sol`) measures about 17,000, so this rounds up. The
 * batch simulation needs it because it measures the gas of an item at the single entry.
 */
export const BATCH_ITEM_OVERHEAD_GAS = 20_000n;

/** How many times the runner simulates a batch again after items dropped out of it, before it gives up on the rest. */
export const MAXIMUM_SETTLING_ROUNDS = 3;

/**
 * The gas the runner assumes for the light client update of a batch when the update alone cannot be simulated. The
 * router test measures about 337,000 for one update.
 */
export const UPDATE_GAS_FALLBACK = 337_000n;

/** A light client update that a batch may carry, and the light client it goes to. */
export interface UpdateOffer {
  readonly message: ProofMessage;
  readonly lightClient: Address;
}

/** Why an update that was offered to a batch did not go with it. */
export type UpdateDropReason =
  /** The light client refuses the update because its head is at or past it, so someone else posted it. The update is done. */
  | "head-already-advanced"
  /** The light client would revert the update. It is not offered again. */
  | "update-failed"
  /** The tips cover the deliveries and not the update as well. The batch is not sent. The runner may post the update alone. */
  | "update-unpaid"
  /** No transaction left, so the update is still pending. */
  | "no-batch";

/** What became of the update of a batch call. */
export type UpdateFate =
  | { readonly kind: "not-offered" }
  | {
      readonly kind: "mined";
      /** Whether the light client took the update, from its `HeadUpdated` event in the receipt. */
      readonly applied: boolean;
      readonly transactionHash: Hex;
      /** The share of the transaction that belongs to the update, by its assumed gas. */
      readonly gasUsed: bigint;
      readonly gasCostWei: bigint;
    }
  | { readonly kind: "dropped"; readonly reason: UpdateDropReason; readonly detail: string };

/** The result of {@link sendBatch}: one outcome for each item in the order given, and the fate of the update. */
export interface BatchReport {
  readonly outcomes: DeliveryOutcome[];
  readonly update: UpdateFate;
}

/** An item that left the batch, with the skip that says why. */
interface Dropped {
  readonly ready: ReadyDelivery;
  readonly outcome: Skip;
}

/** A batch that simulated with every item executed and every item paying. */
interface SendPlan {
  readonly call: CallRequest;
  readonly terms: SendTerms;
  /** The gas assumed for each item: its simulated gas at the single entry plus {@link BATCH_ITEM_OVERHEAD_GAS}. Also the weight of its share of the cost. */
  readonly itemGas: readonly bigint[];
  /** What the fee of each item is worth in wei at its gas. */
  readonly feeWei: readonly bigint[];
  /** The assumed gas of the update, or zero when the call carries none. */
  readonly updateGas: bigint;
}

interface UpdateDrop {
  readonly reason: UpdateDropReason;
  readonly detail: string;
}

type Evaluation =
  | { readonly kind: "send"; readonly plan: SendPlan }
  | { readonly kind: "dropped"; readonly dropped: readonly Dropped[]; readonly droppedUpdate: UpdateDrop | null };

function routerOf(dependencies: DeliveryDependencies): { readonly deliveryRouter: Address; readonly reward: Address; readonly multicall: Address } {
  if (dependencies.deliveryRouter === null || dependencies.rewardAddress === null || dependencies.multicall === null) {
    throw new Error("a batch needs a delivery router, a reward address and a Multicall3 address, and the runner has none");
  }
  return { deliveryRouter: dependencies.deliveryRouter, reward: dependencies.rewardAddress, multicall: dependencies.multicall };
}

/**
 * The calls of a batch, in order: the update at the light client when one is offered, then one
 * `executeMessage` at the delivery router for each item. Multicall3 allows failure on each, so no call reverts another.
 */
function batchCalls(dependencies: DeliveryDependencies, readies: readonly ReadyDelivery[], update: UpdateOffer | null): BatchedCall[] {
  const { deliveryRouter } = routerOf(dependencies);
  const updateCalls: BatchedCall[] =
    update === null
      ? []
      : [{ target: update.lightClient, callData: encodeFunctionData({ abi: beaconLightClientAbi, functionName: "update", args: [update.message.proof, update.message.publicValues] }) }];
  return [...updateCalls, ...readies.map((ready) => ({ target: deliveryRouter, callData: singleCallData(ready.proof) }))];
}

function batchCall(dependencies: DeliveryDependencies, readies: readonly ReadyDelivery[], update: UpdateOffer | null): CallRequest {
  const { multicall } = routerOf(dependencies);
  return { to: multicall, data: encodeAggregate3(batchCalls(dependencies, readies, update)) };
}

/** What a read-only run of the batch returns: the result of the update, when offered, and of each item. */
interface BatchReading {
  readonly update: BatchedCallResult | null;
  readonly items: readonly BatchedCallResult[];
}

/** Runs the batch as a read-only call and reads what Multicall3 returns. @throws when the call reverts or the array has the wrong length. */
async function readResults(chain: TransactionPort, call: CallRequest, shape: { readonly count: number; readonly hasUpdate: boolean }): Promise<BatchReading> {
  const answer = await chain.call(call);
  const results = decodeAggregate3(answer);
  const expected = shape.count + (shape.hasUpdate ? 1 : 0);
  if (results.length !== expected) throw new Error(`Multicall3 returned ${results.length} results for ${expected} calls`);
  return shape.hasUpdate ? { update: results[0] as BatchedCallResult, items: results.slice(1) } : { update: null, items: results };
}

/** The errors that the calls of a batch can revert with: the bridge, the router and the light client. */
const BATCH_ERRORS_ABI = [...messageBridgeAbi, ...deliveryRouterAbi, ...beaconLightClientAbi].filter((entry) => entry.type === "error") as Abi;

/** The name of the error in revert data, or null when the data is empty or holds an error that this build does not know. */
function errorNameOf(returnData: Hex): string | null {
  try {
    return decodeErrorResult({ abi: BATCH_ERRORS_ABI, data: returnData }).errorName;
  } catch {
    return null;
  }
}

function describeRevert(result: BatchedCallResult): string {
  const name = errorNameOf(result.returnData);
  return `${name === null ? "an error that this build does not know" : name}, keccak256 of the revert data is ${result.revertDataHash}`;
}

/** Says why an update that the batch carried did not take effect in a read-only run, or null when it did. */
function updateDropOf(offered: UpdateOffer | null, result: BatchedCallResult | null): UpdateDrop | null {
  if (offered === null || result === null || result.success) return null;
  if (errorNameOf(result.returnData) === "HeadNotAdvancing") return { reason: "head-already-advanced", detail: "the light client head is at or past the update" };
  return { reason: "update-failed", detail: `the light client reverted: ${describeRevert(result)}` };
}

/** What a failed call means for the item. */
function skipOfResult(messageId: Hex, result: BatchedCallResult): Skip {
  const name = errorNameOf(result.returnData);
  if (name === "AnchorNotStored") return skip(messageId, "anchor-not-stored", { detail: "the light client has not stored the anchor header of the proof yet" });
  if (name === "AlreadyDelivered") return skip(messageId, "already-delivered", { detail: "the bridge shows the message as delivered" });
  if (name === "InsufficientGas") return skip(messageId, "insufficient-gas", { detail: "the gas left does not cover the gas limit of the message" });
  return skip(messageId, "simulation-reverted", { detail: `the call reverted: ${describeRevert(result)}` });
}

function refusedItems(readies: readonly ReadyDelivery[], results: readonly BatchedCallResult[]): Dropped[] {
  return readies.flatMap((ready, index) => {
    const result = results[index] as BatchedCallResult;
    return result.success ? [] : [{ ready, outcome: skipOfResult(ready.messageId, result) }];
  });
}

function droppedAll(readies: readonly ReadyDelivery[], reason: string): Evaluation {
  return { kind: "dropped", droppedUpdate: null, dropped: readies.map((ready) => ({ ready, outcome: skip(ready.messageId, "simulation-reverted", { detail: reason }) })) };
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * One round of the simulation of a batch.
 *
 * 1. Simulate the batch and read what Multicall3 returns for each call. When the batch carries an update that the light
 *    client would refuse, the update leaves the batch. Every item whose call would fail leaves the batch too.
 * 2. Measure the gas of each remaining item at the single entry of the router, and the gas of the update at the light
 *    client. The gas estimate of the batch itself cannot serve: the batch never reverts, because Multicall3 allows each
 *    call to fail, so an estimate settles on a gas amount at which most calls fail.
 * 3. Judge the fee of each item at its own gas against its own share of the cost plus the margin. Each judgement
 *    stands alone, so all items that do not pay leave the batch together.
 * 4. Require that the surplus of the tips (fee less cost less margin, summed over the items) covers the cost of the
 *    update plus the margin. When it does not, nothing is sent: the update is the price of the batch.
 * 5. Read the results again under the gas limit that the transaction would use, so that a limit which is too short
 *    shows as failed calls.
 *
 * A round that dropped something tells the caller to simulate what is left again.
 */
async function evaluateBatch(dependencies: DeliveryDependencies, readies: readonly ReadyDelivery[], update: UpdateOffer | null): Promise<Evaluation> {
  const { chain, settings } = dependencies;
  const { deliveryRouter } = routerOf(dependencies);
  const call = batchCall(dependencies, readies, update);
  const shape = { count: readies.length, hasUpdate: update !== null };
  const simulation = await chain.simulate(call);
  if (!simulation.ok) return droppedAll(readies, simulation.reason);
  const first = await readResults(chain, call, shape).catch((error: unknown) => reasonOf(error));
  if (typeof first === "string") return droppedAll(readies, first);
  const droppedUpdate = updateDropOf(update, first.update);
  if (droppedUpdate !== null) return { kind: "dropped", dropped: [], droppedUpdate };
  const refused = refusedItems(readies, first.items);
  if (refused.length > 0) return { kind: "dropped", dropped: refused, droppedUpdate: null };

  const unmeasurable: Dropped[] = [];
  const itemGas: bigint[] = [];
  for (const ready of readies) {
    const single = await chain.simulate({ to: deliveryRouter, data: singleCallData(ready.proof) });
    if (!single.ok) {
      unmeasurable.push({ ready, outcome: skip(ready.messageId, "simulation-reverted", { detail: single.reason }) });
      continue;
    }
    itemGas.push(single.gas + BATCH_ITEM_OVERHEAD_GAS);
  }
  if (unmeasurable.length > 0) return { kind: "dropped", dropped: unmeasurable, droppedUpdate: null };

  const quote = await chain.feeQuote();
  const judgements = await Promise.all(
    readies.map((ready, index) => judgeOffer(dependencies, { item: ready.item, offer: ready.offer, feeGasUnits: itemGas[index] as bigint, costGasUnits: itemGas[index] as bigint, quote, messageId: ready.messageId })),
  );
  const unpaid: Dropped[] = [];
  const feeWei: bigint[] = [];
  for (const [index, ready] of readies.entries()) {
    const judgement = judgements[index] as Judgement;
    if (judgement.kind === "pay") feeWei.push(judgement.feeWei);
    else unpaid.push({ ready, outcome: judgement.outcome });
  }
  if (unpaid.length > 0) return { kind: "dropped", dropped: unpaid, droppedUpdate: null };

  const updateGas = update === null ? 0n : await gasOfUpdate(chain, update);
  const unpaidUpdate = unpaidUpdateOf({ dependencies, readies, feeWei, itemGas, updateGas, quote });
  if (unpaidUpdate !== null) return unpaidUpdate;

  const needed = itemGas.reduce((sum, gas) => sum + gas, updateGas);
  const buffered = sendTerms(quote, simulation.gas > needed ? simulation.gas : needed);
  // The limit never passes the setting. A limit that is too short for the last item shows in the next read as a skip.
  const terms = buffered.gas > settings.maximumBatchGas ? { ...buffered, gas: settings.maximumBatchGas } : buffered;
  const limited = await readResults(chain, { ...call, gas: terms.gas }, shape).catch((error: unknown) => reasonOf(error));
  if (typeof limited === "string") return droppedAll(readies, limited);
  const updateAtLimit = updateDropOf(update, limited.update);
  if (updateAtLimit !== null) return { kind: "dropped", dropped: [], droppedUpdate: updateAtLimit };
  const refusedAtLimit = refusedItems(readies, limited.items);
  if (refusedAtLimit.length > 0) return { kind: "dropped", dropped: refusedAtLimit, droppedUpdate: null };

  return { kind: "send", plan: { call, terms, itemGas, feeWei, updateGas } };
}

/** The gas of the update at the light client, or {@link UPDATE_GAS_FALLBACK} when it cannot be simulated alone. */
async function gasOfUpdate(chain: TransactionPort, update: UpdateOffer): Promise<bigint> {
  const data = encodeFunctionData({ abi: beaconLightClientAbi, functionName: "update", args: [update.message.proof, update.message.publicValues] });
  const simulation = await chain.simulate({ to: update.lightClient, data });
  return simulation.ok ? simulation.gas : UPDATE_GAS_FALLBACK;
}

/**
 * Checks that the tips of the batch pay for the update as well. Every item already passed alone, so each has a surplus
 * of fee over cost and margin. The surplus of all items together must cover the cost of the update and the margin. When it
 * does not, no item is better off to leave (an item only adds surplus), so the whole batch is skipped and the update is
 * not part of it. Returns null when the batch pays.
 */
function unpaidUpdateOf(input: {
  readonly dependencies: DeliveryDependencies;
  readonly readies: readonly ReadyDelivery[];
  readonly feeWei: readonly bigint[];
  readonly itemGas: readonly bigint[];
  readonly updateGas: bigint;
  readonly quote: FeeQuote;
}): Evaluation | null {
  if (input.updateGas === 0n) return null;
  const { minimumMarginWei } = input.dependencies.settings;
  const price = input.quote.baseFee + input.quote.priorityFee;
  const surplus = input.readies.reduce((sum, _ready, index) => sum + (input.feeWei[index] as bigint) - (input.itemGas[index] as bigint) * price - minimumMarginWei, 0n);
  const updateCost = input.updateGas * price;
  if (surplus >= updateCost + minimumMarginWei) return null;
  const detail = `the tips pay the deliveries and leave ${surplus} wei, and the update costs ${updateCost} wei with a margin of ${minimumMarginWei}`;
  return {
    kind: "dropped",
    droppedUpdate: { reason: "update-unpaid", detail },
    dropped: input.readies.map((ready, index) => ({
      ready,
      outcome: skip(ready.messageId, "fee-below-cost-plus-margin", {
        feeWei: input.feeWei[index] as bigint,
        costWei: (input.itemGas[index] as bigint) * price,
        detail: `the batch carries a light client update. ${detail}`,
      }),
    })),
  };
}

/** The share of `total` that belongs to an item of `weight` out of `weights`. It rounds down. */
function shareOf(total: bigint, weight: bigint, weights: bigint): bigint {
  return (total * weight) / weights;
}

/** What the receipt of a batch shows. Multicall3 writes no event of its own, so the events of the bridge and the light client are the evidence. */
interface ReceiptReading {
  /** The message identifiers that the bridge reports as executed, from `AffirmationCompleted`. */
  readonly executed: ReadonlySet<Hex>;
  /** The tokens that arrived at the reward address, by message identifier of the executed items. */
  readonly tokensByMessage: ReadonlyMap<Hex, bigint>;
  /** Whether the light client reports the head of the offered update, from `HeadUpdated`. */
  readonly updateApplied: boolean;
}

/** The identifier of the message in an `AffirmationCompleted` log, or null for any other log. */
function affirmedMessageOf(log: ReceiptSummary["logs"][number]): Hex | null {
  try {
    const event = decodeEventLog({ abi: messageBridgeAbi, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
    return event.eventName === "AffirmationCompleted" ? event.args.messageId : null;
  } catch {
    return null;
  }
}

/** Whether a log is `HeadUpdated` of the light client for the slot. */
function isHeadUpdated(log: ReceiptSummary["logs"][number], lightClient: Address, slot: bigint): boolean {
  if (log.address.toLowerCase() !== lightClient.toLowerCase()) return false;
  try {
    const event = decodeEventLog({ abi: beaconLightClientAbi, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
    return event.eventName === "HeadUpdated" && BigInt(event.args.slot) === slot;
  } catch {
    return false;
  }
}

/** Whether a log is a `Transfer` of tokens to the account, from any token. */
function isTransferTo(log: ReceiptSummary["logs"][number], account: Address): boolean {
  try {
    const event = decodeEventLog({ abi: erc20Abi, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
    return event.eventName === "Transfer" && event.args.to.toLowerCase() === account.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Reads the receipt of a batch. The bridge says which messages it executed. The fee of an item reaches the reward
 * address inside the call of the item, after the mediator released the tokens to the router. So the logs from one
 * release to the router up to the next one belong to one executed item, and the executed items appear in the order of the
 * batch. The tokens of one item are known exactly, and there is no need to divide a sum among items.
 */
function readReceipt(dependencies: DeliveryDependencies, readies: readonly ReadyDelivery[], update: UpdateOffer | null, receipt: ReceiptSummary): ReceiptReading {
  const { deliveryRouter, reward } = routerOf(dependencies);
  const executed = new Set<Hex>();
  for (const log of receipt.logs) {
    const messageId = affirmedMessageOf(log);
    if (messageId !== null) executed.add(messageId);
  }
  const segments: ReceiptSummary["logs"][number][][] = [];
  for (const log of receipt.logs) {
    if (isTransferTo(log, deliveryRouter)) segments.push([]);
    segments.at(-1)?.push(log);
  }
  const tokensByMessage = new Map<Hex, bigint>();
  readies
    .filter((ready) => executed.has(ready.messageId))
    .forEach((ready, order) => {
      const token = ready.item.transfer?.destinationToken.address as Address | undefined;
      const segment = segments[order];
      if (token !== undefined && segment !== undefined) tokensByMessage.set(ready.messageId, tokensReceived(segment, token, reward));
    });
  const updateApplied = update !== null && receipt.logs.some((log) => isHeadUpdated(log, update.lightClient, update.message.newSlot));
  return { executed, tokensByMessage, updateApplied };
}

/** What {@link settleReceipt} makes of a mined batch. */
interface Settlement {
  readonly outcomes: DeliveryOutcome[];
  readonly update: UpdateFate;
}

/**
 * Settles a mined batch into one outcome for each item, in the order of the batch, and the fate of the update.
 *
 * - The whole transaction reverted: every item failed, and the whole cost is a loss.
 * - Otherwise the bridge events say which items executed. Executed items are delivered with their share of the gas by
 *   weight. The update takes its own share. An item that did not execute failed in the mined block, and the receipt
 *   keeps no reason for it (Multicall3 drops the revert data). The cost share of every item that did not execute, and of an update that was not applied, is an
 *   unrecovered loss, recorded in one call. An applied update is not a loss: the tips were priced to pay for it.
 */
async function settleReceipt(
  dependencies: DeliveryDependencies,
  ledger: PrerequisiteLedger,
  input: { readonly readies: readonly ReadyDelivery[]; readonly plan: SendPlan; readonly update: UpdateOffer | null; readonly receipt: ReceiptSummary },
): Promise<Settlement> {
  const { readies, plan, receipt } = input;
  const costWei = receipt.gasUsed * receipt.effectiveGasPrice;
  const layoutLoss = readies.reduce((sum, ready) => sum + ready.prerequisiteCostWei, 0n);
  const offeredUpdate = plan.updateGas > 0n;
  if (!receipt.success) {
    await ledger.recordLoss(costWei + layoutLoss);
    return {
      update: offeredUpdate ? { kind: "dropped", reason: "update-failed", detail: `the transaction ${receipt.hash} reverted` } : { kind: "not-offered" },
      outcomes: readies.map((ready) => ({
        status: "failed",
        messageId: ready.messageId,
        reason: "transaction-reverted",
        transactionHash: receipt.hash,
        ...(ready.prerequisiteCostWei > 0n ? { prerequisiteCostWei: ready.prerequisiteCostWei } : {}),
      })),
    };
  }

  const reading = readReceipt(dependencies, readies, input.update, receipt);
  const totalWeight = plan.itemGas.reduce((sum, gas) => sum + gas, plan.updateGas);
  let unexecutedCostWei = 0n;
  const outcomes: DeliveryOutcome[] = [];
  for (const [index, ready] of readies.entries()) {
    const weight = plan.itemGas[index] as bigint;
    if (reading.executed.has(ready.messageId)) {
      const gasUsed = shareOf(receipt.gasUsed, weight, totalWeight);
      dependencies.logger.info("delivery_sent", { messageId: ready.messageId, path: "delivery-router", transactionHash: receipt.hash, gasUsed });
      outcomes.push({
        status: "delivered",
        messageId: ready.messageId,
        path: "delivery-router",
        transactionHash: receipt.hash,
        gasUsed,
        gasCostWei: gasUsed * receipt.effectiveGasPrice,
        prerequisiteCostWei: ready.prerequisiteCostWei,
        feeExpectedWei: plan.feeWei[index] as bigint,
        feeReceivedTokens: reading.tokensByMessage.get(ready.messageId) ?? null,
      });
      continue;
    }
    unexecutedCostWei += shareOf(costWei, weight, totalWeight);
    await ledger.recordLoss(ready.prerequisiteCostWei);
    outcomes.push({
      status: "failed",
      messageId: ready.messageId,
      reason: "batch-result-missing",
      transactionHash: receipt.hash,
      ...(ready.prerequisiteCostWei > 0n ? { prerequisiteCostWei: ready.prerequisiteCostWei } : {}),
    });
  }
  const update = offeredUpdate ? settleUpdate(receipt, { plan, applied: reading.updateApplied, totalWeight }) : ({ kind: "not-offered" } as const);
  if (update.kind === "mined" && !update.applied) unexecutedCostWei += update.gasCostWei;
  if (unexecutedCostWei > 0n) {
    dependencies.logger.warn("delivery_batch_loss", { transactionHash: receipt.hash, lossWei: unexecutedCostWei });
    await ledger.recordLoss(unexecutedCostWei);
  }
  return { outcomes, update };
}

/** The fate of the update in a mined batch, from the `HeadUpdated` event of the light client. */
function settleUpdate(receipt: ReceiptSummary, input: { readonly plan: SendPlan; readonly applied: boolean; readonly totalWeight: bigint }): UpdateFate {
  const gasUsed = shareOf(receipt.gasUsed, input.plan.updateGas, input.totalWeight);
  return { kind: "mined", applied: input.applied, transactionHash: receipt.hash, gasUsed, gasCostWei: gasUsed * receipt.effectiveGasPrice };
}

/** Input of {@link sendBatch}. */
export interface SendBatchInput {
  readonly readies: readonly ReadyDelivery[];
  /** A light client update to carry in the same transaction, or null. */
  readonly update: UpdateOffer | null;
}

/**
 * Sends the ready items through Multicall3 (`aggregate3`, failure allowed on each call), in one transaction, and returns one outcome for
 * each item in the order given, and the fate of the update.
 *
 * The update call goes first inside the transaction, to the light client, and the item calls follow, to the delivery router.
 * A stale or wrong update never reverts the batch. The simulation finds out first: an update that the light client would refuse leaves
 * the batch, and so does a batch whose tips do not pay for the update as well.
 *
 * Nothing leaves without a simulation of exactly this batch in which the update (if any) is applied, every item
 * executes and every item pays. After a round that drops items, the smaller batch is simulated again, at most
 * {@link MAXIMUM_SETTLING_ROUNDS} times. Items that are still in flux after the last round are skipped with
 * "batch-did-not-settle": they are tried again later.
 *
 * Before the send the ledger reserves the worst case of the whole transaction (gas limit times maximum fee per gas).
 * At the receipt it settles the reservation to the actual cost. A send that throws never settles, and this function
 * lets the error pass, so the reservation stays charged. Whatever the receipt shows, the cost share of items that did not
 * execute is an unrecovered loss.
 *
 * @throws when the send throws. The transaction may be in the pool.
 */
export async function sendBatch(dependencies: DeliveryDependencies, ledger: PrerequisiteLedger, input: SendBatchInput): Promise<BatchReport> {
  const { readies } = input;
  const dropped = new Map<Hex, Skip>();
  let remaining = [...readies];
  let offer = input.update;
  let fate: UpdateFate = offer === null ? { kind: "not-offered" } : { kind: "dropped", reason: "no-batch", detail: "no transaction was sent" };
  let plan: SendPlan | null = null;
  let rounds = 0;
  while (plan === null && remaining.length > 0 && rounds < MAXIMUM_SETTLING_ROUNDS) {
    const evaluation = await evaluateBatch(dependencies, remaining, offer);
    if (evaluation.kind === "send") {
      plan = evaluation.plan;
      continue;
    }
    if (evaluation.droppedUpdate !== null) {
      fate = { kind: "dropped", ...evaluation.droppedUpdate };
      offer = null;
    }
    if (evaluation.dropped.length > 0) rounds += 1;
    for (const entry of evaluation.dropped) dropped.set(entry.ready.messageId, await recordLoss(dependencies, ledger, entry.outcome, entry.ready.prerequisiteCostWei));
    remaining = remaining.filter((ready) => !dropped.has(ready.messageId));
  }
  if (plan === null) {
    for (const ready of remaining) {
      const unsettled = skip(ready.messageId, "batch-did-not-settle", { detail: `the batch kept changing for ${MAXIMUM_SETTLING_ROUNDS} rounds` });
      dropped.set(ready.messageId, await recordLoss(dependencies, ledger, unsettled, ready.prerequisiteCostWei));
    }
    return { outcomes: readies.map((ready) => dropped.get(ready.messageId) as Skip), update: fate };
  }

  const reservation = await ledger.reserveDelivery(worstCaseCostWei(plan.terms));
  const receipt = await dependencies.chain.send({ ...plan.call, ...plan.terms });
  await ledger.settleDelivery(reservation, receipt.gasUsed * receipt.effectiveGasPrice);
  dependencies.logger.info("delivery_batch_mined", {
    transactionHash: receipt.hash,
    items: remaining.length,
    withUpdate: plan.updateGas > 0n,
    success: receipt.success,
    gasUsed: receipt.gasUsed,
    rollingDeliverySpendWei: await ledger.deliverySpendWei(),
  });
  const settled = await settleReceipt(dependencies, ledger, { readies: remaining, plan, update: offer, receipt });
  const byMessage = new Map<Hex, DeliveryOutcome>([...dropped, ...settled.outcomes.map((outcome) => [outcome.messageId, outcome] as const)]);
  return { outcomes: readies.map((ready) => byMessage.get(ready.messageId) as DeliveryOutcome), update: settled.update.kind === "not-offered" ? fate : settled.update };
}

/**
 * Delivers one covered item, or says why not: {@link prepareItem}, then a batch of one through {@link sendBatch}. The
 * runner prepares many items and sends them together. This function serves a single item.
 */
export async function deliverItem(dependencies: DeliveryDependencies, item: FeedItem, ledger: PrerequisiteLedger): Promise<DeliveryOutcome> {
  const preparation = await prepareItem(dependencies, item, ledger);
  if (preparation.kind === "outcome") return preparation.outcome;
  const { outcomes } = await sendBatch(dependencies, ledger, { readies: [preparation.ready], update: null });
  return outcomes[0] as DeliveryOutcome;
}
