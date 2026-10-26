import type { Address, Hex } from "viem";
import type { ProofDirection, ProofMessage } from "@zk-bridge/shared";
import type { LightClientReader } from "../chain/light-client.ts";
import type { FeedItem } from "../indexer/client.ts";
import type { Logger } from "../logging/logger.ts";
import type { StateStore } from "../runtime/state-file.ts";
import { sendBatch, type UpdateFate, type UpdateOffer } from "./batch.ts";
import { planBatches } from "./batch-plan.ts";
import { isFinal, prepareItem, type DeliveryDependencies, type DeliveryOutcome, type Preparation, type ReadyDelivery } from "./delivery.ts";
import { createPrerequisiteLedger, type BudgetStore, type PrerequisiteLedger } from "./prerequisite-ledger.ts";
import type { OutcomeSink } from "./outcomes.ts";
import { assessProofPayload, payloadKey, type ProofRefusal } from "./proof-intake.ts";
import { createSerialQueue, type SerialQueue } from "./serial-queue.ts";
import type { PrerequisiteBudgetState, RunnerState } from "./state.ts";
import { postUpdate } from "./update.ts";

/** Everything the runner needs for one pair and direction. */
export interface RunnerDependencies {
  readonly pairName: string;
  readonly direction: ProofDirection;
  readonly sourceChainId: number;
  readonly destinationChainId: number;
  readonly lightClientAddress: Address;
  readonly lightClient: LightClientReader;
  /** The delivery parts: the chain, the prover, the indexer, the source reader and the fee settings. */
  readonly delivery: DeliveryDependencies;
  /** The state file. The runner changes it only through `update`, because another writer may share the file. */
  readonly state: StateStore<RunnerState>;
  readonly outcomes: OutcomeSink;
  readonly queue: SerialQueue;
  readonly now: () => number;
  /**
   * The most deliveries a sweep tries. A sweep that reserved or spent gas on layout calls counts for one, also when it
   * skipped, and also when a call threw.
   */
  readonly maximumDeliveriesPerSweep: number;
  /** How long an item is not tried again after layout calls were paid for it and the delivery did not follow. */
  readonly prerequisiteLossRefusalMilliseconds: number;
  readonly logger: Logger;
}

/** What the runner did with one message of the board. */
export type ProofHandling =
  | { readonly handled: "duplicate" }
  | { readonly handled: "refused"; readonly reason: ProofRefusal; readonly detail?: string }
  | { readonly handled: "update-posted"; readonly transactionHash: Hex }
  | { readonly handled: "update-skipped"; readonly reason: string; readonly detail: string };

/** What a sweep did. */
export interface SweepSummary {
  readonly listed: number;
  readonly delivered: number;
  readonly skipped: number;
  readonly failed: number;
}

/** The counts of a sweep while it runs. */
type SweepCounts = { -readonly [Key in keyof SweepSummary]: SweepSummary[Key] };

/** The runner for one pair and direction. */
export interface Runner {
  /** Checks one message of the board, and posts `update` when it is a proof that moves the head. */
  handleProofPayload(payload: Hex): Promise<ProofHandling>;
  /** Lists the covered items and delivers those that pay. */
  sweep(): Promise<SweepSummary>;
}

/** How long a message that was looked at is not looked at again. The publisher posts it again every few minutes. */
export const PAYLOAD_MEMORY_MILLISECONDS = 5 * 60 * 1000;
/** How long an item waits after a failure that costs time to find again, such as evidence or a revert. */
export const RETRY_AFTER_MILLISECONDS = 5 * 60 * 1000;
/** The pages of the feed that one sweep reads. */
const MAXIMUM_PAGES = 5;
const PAGE_SIZE = 100;

/**
 * Skip reasons that the next sweep can settle at once: they compare numbers that change with each block, or (anchor not
 * stored) wait for a light client update that may land any moment.
 */
const CHEAP_REASONS: ReadonlySet<string> = new Set(["no-fee-offer", "fee-below-cost-plus-margin", "no-price-for-fee-token", "anchor-not-stored"]);

/** Builds the runner. It keeps in memory only caches that a restart may lose; the state file keeps what must last. */
export function createRunner(dependencies: RunnerDependencies): Runner {
  const { logger, queue } = dependencies;
  const seenPayloads = new Map<Hex, number>();
  const retryAfter = new Map<string, number>();
  const lastSkipReason = new Map<string, string>();
  const base = { pair: dependencies.pairName, direction: dependencies.direction };
  /** The proof that waits to be posted: with the next batch, or alone at the end of a sweep. */
  let pendingUpdate: ProofMessage | null = null;
  /** What became of each update, for the caller of `handleProofPayload`. */
  const updateHandlings = new WeakMap<ProofMessage, ProofHandling>();

  function remembered(payload: Hex): boolean {
    const key = payloadKey(payload);
    const now = dependencies.now();
    for (const [seen, at] of seenPayloads) if (now - at > PAYLOAD_MEMORY_MILLISECONDS) seenPayloads.delete(seen);
    if (seenPayloads.has(key)) return true;
    seenPayloads.set(key, now);
    return false;
  }

  async function handleProofPayload(payload: Hex): Promise<ProofHandling> {
    if (remembered(payload)) return { handled: "duplicate" };
    const assessment = await assessProofPayload({
      payload,
      pairName: dependencies.pairName,
      direction: dependencies.direction,
      lightClient: dependencies.lightClient,
      prover: dependencies.delivery.prover,
    });
    if (!assessment.accept) {
      logger.debug("proof_refused", { reason: assessment.reason, detail: assessment.detail });
      // A proof that fails verification is worth a warning: someone posted a forgery or a broken proof.
      if (assessment.reason === "proof-does-not-verify") logger.warn("proof_forgery_refused", { detail: assessment.detail });
      return { handled: "refused", reason: assessment.reason, detail: assessment.detail };
    }
    const message = assessment.message;
    // The update waits for the sweep. A batch carries it when one follows, and the sweep posts it alone when none does.
    if (pendingUpdate === null || pendingUpdate.newSlot < message.newSlot) pendingUpdate = message;
    await runSweep();
    return updateHandlings.get(message) ?? { handled: "update-skipped", reason: "superseded", detail: "another update was posted or is waiting with a higher slot" };
  }

  /** Posts the update alone, with its own simulation. A revert usually means that someone else posted first. */
  async function postUpdateAlone(message: ProofMessage): Promise<void> {
    const outcome = await queue.run(() => postUpdate({ chain: dependencies.delivery.chain, lightClient: dependencies.lightClientAddress, message }));
    if (!outcome.posted) {
      await finishUpdate(message, { kind: "skipped", reason: outcome.reason, detail: outcome.detail });
      return;
    }
    await finishUpdate(message, { kind: "posted", transactionHash: outcome.transactionHash, gasUsed: outcome.gasUsed, gasCostWei: outcome.gasUsed * outcome.effectiveGasPrice });
  }

  /** How an update ended. */
  type UpdateEnding =
    | { readonly kind: "posted"; readonly transactionHash: Hex; readonly gasUsed: bigint; readonly gasCostWei: bigint }
    | { readonly kind: "skipped"; readonly reason: string; readonly detail: string };

  /** Records how the pending update ended, answers the caller of `handleProofPayload`, and clears the pending update. */
  async function finishUpdate(message: ProofMessage, ending: UpdateEnding): Promise<void> {
    if (pendingUpdate === message) pendingUpdate = null;
    const fields = { startSlot: message.startSlot, newSlot: message.newSlot };
    if (ending.kind === "skipped") {
      logger.info("update_skipped", { reason: ending.reason, detail: ending.detail, newSlot: message.newSlot });
      await dependencies.outcomes.record({ kind: "update", ...base, status: "skipped", reason: ending.reason, detail: ending.detail, ...fields });
      updateHandlings.set(message, { handled: "update-skipped", reason: ending.reason, detail: ending.detail });
      return;
    }
    logger.info("update_posted", { transactionHash: ending.transactionHash, newSlot: message.newSlot, gasUsed: ending.gasUsed });
    await dependencies.outcomes.record({ kind: "update", ...base, status: "posted", transactionHash: ending.transactionHash, ...fields, gasUsed: ending.gasUsed, gasCostWei: ending.gasCostWei });
    updateHandlings.set(message, { handled: "update-posted", transactionHash: ending.transactionHash });
  }

  /**
   * The update that the next batch carries, or null. An update that the head has passed is done: someone else posted
   * it, and no transaction is needed.
   */
  async function offerUpdate(): Promise<UpdateOffer | null> {
    const message = pendingUpdate;
    if (message === null) return null;
    const head = await dependencies.lightClient.read();
    if (head.headSlot >= message.newSlot) {
      await finishUpdate(message, { kind: "skipped", reason: "already-stored", detail: `the head is at slot ${head.headSlot}` });
      return null;
    }
    return { message, lightClient: dependencies.lightClientAddress };
  }

  /** Learns what became of the update that a batch carried. Returns true when the update was declined as unpaid, so that no later batch offers it. */
  async function settleUpdateFate(offer: UpdateOffer | null, fate: UpdateFate): Promise<boolean> {
    if (offer === null || fate.kind === "not-offered") return false;
    if (fate.kind === "mined") {
      const ending: UpdateEnding = fate.applied
        ? { kind: "posted", transactionHash: fate.transactionHash, gasUsed: fate.gasUsed, gasCostWei: fate.gasCostWei }
        : { kind: "skipped", reason: "update-failed", detail: `the light client reports no head update in ${fate.transactionHash}: another account may have posted first` };
      await finishUpdate(offer.message, ending);
      return false;
    }
    if (fate.reason === "head-already-advanced" || fate.reason === "update-failed") {
      await finishUpdate(offer.message, { kind: "skipped", reason: fate.reason, detail: fate.detail });
      return false;
    }
    logger.info("update_waits", { reason: fate.reason, detail: fate.detail, newSlot: offer.message.newSlot });
    return fate.reason === "update-unpaid";
  }

  async function listCovered(finished: ReadonlySet<string>): Promise<readonly FeedItem[]> {
    const items: FeedItem[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAXIMUM_PAGES; page += 1) {
      const result = await dependencies.delivery.indexer.listFeed({
        sourceChainId: dependencies.sourceChainId,
        destinationChainId: dependencies.destinationChainId,
        statuses: ["covered"],
        limit: PAGE_SIZE,
        cursor,
      });
      items.push(...result.items.filter((item) => !finished.has(item.messageId)));
      if (result.nextCursor === null) break;
      cursor = result.nextCursor;
    }
    // The feed lists the newest first. The oldest waits the longest, so it goes first.
    return items.reverse();
  }

  async function record(outcome: DeliveryOutcome): Promise<void> {
    const fields = { ...outcome };
    if (outcome.status === "skipped") {
      const changed = lastSkipReason.get(outcome.messageId) !== outcome.reason;
      lastSkipReason.set(outcome.messageId, outcome.reason);
      if (!changed) return;
      logger.info("delivery_skipped", fields);
    } else {
      logger.info("delivery_outcome", fields);
    }
    await dependencies.outcomes.record({ kind: "delivery", ...base, ...fields });
  }

  /**
   * The rolling spend lives in the state file, next to the finished items. Each change applies to the freshly loaded
   * state under the lock of the file and keeps the other part as it is.
   */
  const budgetStore: BudgetStore = {
    async load() {
      const { prerequisiteSpend, deliverySpend, prerequisiteLosses } = await dependencies.state.load();
      return { prerequisiteSpend, deliverySpend, prerequisiteLosses };
    },
    async update(mutate) {
      await dependencies.state.update((state) => {
        const budget = { prerequisiteSpend: state.prerequisiteSpend, deliverySpend: state.deliverySpend, prerequisiteLosses: state.prerequisiteLosses };
        const next = mutate(budget);
        return next === budget ? state : { ...state, ...next };
      });
    },
  };

  async function attempt(item: FeedItem, ledger: PrerequisiteLedger): Promise<Preparation | null> {
    try {
      return await queue.run(() => prepareItem(dependencies.delivery, item, ledger));
    } catch (error) {
      logger.error("delivery_error", { messageId: item.messageId, error });
      retryAfter.set(item.messageId, dependencies.now() + RETRY_AFTER_MILLISECONDS);
      return null;
    }
  }

  /** An item that waits for a batch. `spentOnPrerequisites` is true when layout calls were sent for it. */
  interface Pending {
    readonly item: FeedItem;
    readonly ready: ReadyDelivery;
    readonly spentOnPrerequisites: boolean;
  }

  /** Records an outcome, counts it, schedules the next look at the item and stores a final result. */
  async function settleOutcome(item: FeedItem, outcome: DeliveryOutcome, summary: SweepCounts, options: { readonly spentOnPrerequisites: boolean }): Promise<void> {
    await record(outcome);
    if (outcome.status === "delivered") summary.delivered += 1;
    if (outcome.status === "skipped") summary.skipped += 1;
    if (outcome.status === "failed") summary.failed += 1;
    if (outcome.status === "skipped" && !CHEAP_REASONS.has(outcome.reason)) retryAfter.set(item.messageId, dependencies.now() + RETRY_AFTER_MILLISECONDS);
    if (outcome.status === "failed") retryAfter.set(item.messageId, dependencies.now() + RETRY_AFTER_MILLISECONDS);
    if (outcome.status === "skipped" && options.spentOnPrerequisites) retryAfter.set(item.messageId, dependencies.now() + dependencies.prerequisiteLossRefusalMilliseconds);
    if (!isFinal(outcome)) return;
    const proof = outcome.status === "delivered" ? outcome.transactionHash : "elsewhere";
    await dependencies.state.update((current) => ({ ...current, finished: { ...current.finished, [item.messageId]: proof } }));
  }

  /**
   * Sends one batch. A send that throws may have broadcast the transaction, so every item of the batch counts as failed
   * and waits. The delivery reservation stays charged in the ledger. The layout calls of the items are a loss.
   */
  async function deliverBatch(batch: readonly Pending[], ledger: PrerequisiteLedger, summary: SweepCounts, update: UpdateOffer | null): Promise<boolean> {
    let report;
    try {
      report = await queue.run(() => sendBatch(dependencies.delivery, ledger, { readies: batch.map((pending) => pending.ready), update }));
    } catch (error) {
      logger.error("delivery_batch_error", { messageIds: batch.map((pending) => pending.item.messageId), error });
      await ledger.recordLoss(batch.reduce((sum, pending) => sum + pending.ready.prerequisiteCostWei, 0n));
      for (const pending of batch) {
        summary.failed += 1;
        const wait = pending.spentOnPrerequisites ? dependencies.prerequisiteLossRefusalMilliseconds : RETRY_AFTER_MILLISECONDS;
        retryAfter.set(pending.item.messageId, dependencies.now() + wait);
      }
      return false;
    }
    for (const [index, pending] of batch.entries()) {
      await settleOutcome(pending.item, report.outcomes[index] as DeliveryOutcome, summary, { spentOnPrerequisites: pending.spentOnPrerequisites });
    }
    return settleUpdateFate(update, report.update);
  }

  /**
   * One sweep. The runner first prepares the items oldest first: offers, evidence, layout calls. An item with a fee
   * offer that passes waits as ready. When the preparation is over, the ready items go to the delivery router in as few batches
   * as the limits allow, and each batch is one transaction. An item without an offer goes directly to the bridge, alone.
   * A prepared item counts as one attempt of the sweep, whether or not its batch later drops it.
   */
  async function sweepOnce(): Promise<SweepSummary> {
    const state = await dependencies.state.load();
    const finished = new Set(Object.keys(state.finished));
    const listed = await listCovered(finished);
    const summary = { listed: listed.length, delivered: 0, skipped: 0, failed: 0 };
    const { settings } = dependencies.delivery;
    const ledger = createPrerequisiteLedger({
      capWei: settings.maximumPrerequisiteSpendPerSweepWei,
      limits: { dailySpendWei: settings.maximumPrerequisiteSpendPerDayWei, unrecoveredLossWei: settings.maximumUnrecoveredPrerequisiteLossWei },
      store: budgetStore,
      now: dependencies.now,
      logger,
    });
    let attempts = 0;
    const waiting: Pending[] = [];
    for (const item of listed) {
      if (attempts >= dependencies.maximumDeliveriesPerSweep) break;
      if ((retryAfter.get(item.messageId) ?? 0) > dependencies.now()) continue;
      const spentBefore = ledger.spentWei;
      const preparation = await attempt(item, ledger);
      const spentOnPrerequisites = ledger.spentWei > spentBefore;
      if (spentOnPrerequisites) attempts += 1;
      if (preparation === null) {
        summary.failed += 1;
        // An error after a layout call was attempted is spend-bearing: the reservation stays charged, the item counts
        // toward the sweep limit, and the item waits out the refusal window. The charge is an unrecovered loss.
        if (spentOnPrerequisites) await ledger.recordLoss(ledger.spentWei - spentBefore);
        if (spentOnPrerequisites) retryAfter.set(item.messageId, dependencies.now() + dependencies.prerequisiteLossRefusalMilliseconds);
        continue;
      }
      if (preparation.kind === "ready") {
        if (!spentOnPrerequisites) attempts += 1;
        waiting.push({ item, ready: preparation.ready, spentOnPrerequisites });
        continue;
      }
      const { outcome } = preparation;
      if ((outcome.status === "delivered" || outcome.status === "failed") && !spentOnPrerequisites) attempts += 1;
      await settleOutcome(item, outcome, summary, { spentOnPrerequisites });
    }
    const batches = planBatches(
      waiting.map((pending) => ({ ...pending, assumedGas: pending.ready.assumedGas })),
      { maximumBatchSize: settings.maximumBatchSize, maximumBatchGas: settings.maximumBatchGas },
    );
    let updateDeclined = false;
    for (const batch of batches) {
      const update = updateDeclined ? null : await offerUpdate();
      if (await deliverBatch(batch, ledger, summary, update)) updateDeclined = true;
    }
    // No batch took the update, so it goes alone, as it did before batches existed.
    if (pendingUpdate !== null) await postUpdateAlone(pendingUpdate);
    return summary;
  }

  /** A sweep never overlaps the one before it: a proof message that arrives during a sweep waits for its turn. */
  const sweepQueue = createSerialQueue();
  const runSweep = (): Promise<SweepSummary> => sweepQueue.run(sweepOnce);
  const sweep = runSweep;

  return { handleProofPayload, sweep };
}
