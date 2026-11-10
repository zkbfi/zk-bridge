import type { Address, Hex } from "viem";
import type { ProofDirection, ProofMessage } from "@zk-bridge/shared";
import type { FeedItem } from "../indexer/client.ts";
import type { Logger } from "../logging/logger.ts";
import type { StateStore } from "../runtime/state-file.ts";
import { sendBatch, type UpdateFate, type UpdateOffer } from "./batch.ts";
import { planBatches } from "./batch-plan.ts";
import { isFinal, prepareItem, skip, type DeliveryDependencies, type DeliveryOutcome, type Preparation, type PrerequisiteHistory, type ReadyDelivery } from "./delivery.ts";
import { createPrerequisiteLedger, type BudgetStore, type PrerequisiteLedger } from "./prerequisite-ledger.ts";
import type { OutcomeSink } from "./outcomes.ts";
import { assessProofPayload, payloadKey, type LightClientReader, type ProofRefusal, type VerifyGuard } from "@zk-bridge/shared/prover";
import { createSerialQueue, type SerialQueue } from "./serial-queue.ts";
import type { PrerequisiteAttempt, PrerequisiteBudgetState, RunnerState } from "./state.ts";
import { postUpdate } from "./update.ts";
import { unpaidSpentWei, withUnpaidSpend } from "./unpaid-spend.ts";

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
  /**
   * How long an item is not tried again after layout calls were paid for it and the delivery did not follow. The state
   * file keeps the time, so a restart does not cut it short.
   */
  readonly prerequisiteLossRefusalMilliseconds: number;
  readonly logger: Logger;
  /** Accept oracle proofs (version 2). Set it only when the destination verifier is the oracle stand-in. Default: strict. */
  readonly acceptOracleProof?: boolean;
  /**
   * The guard in front of the local proof check, shared by the runners of one process (B-4). It caps the checks per
   * minute, for all runners and for this direction, and remembers the forgeries refused at the current head. Without it
   * every distinct payload that names the head spawns a check.
   */
  readonly verifyGuard?: VerifyGuard;
  /**
   * Called after this runner's update is mined and applied, alone or in a batch. The service opens the bridge here: the
   * opening proof needs the block that the update stored while a node still serves its state.
   */
  readonly onUpdatePosted?: () => Promise<unknown>;
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
/** Refusals of a proof that was not really checked: the message is not remembered, so its next copy gets a look. */
const RETRYABLE_REFUSALS: ReadonlySet<ProofRefusal> = new Set(["verify-budget-exhausted", "verify-unavailable"]);
/** How long an item waits after a failure that costs time to find again, such as evidence or a revert. */
export const RETRY_AFTER_MILLISECONDS = 5 * 60 * 1000;
/** The pages of the feed that one sweep reads. */
const MAXIMUM_PAGES = 5;
const PAGE_SIZE = 100;

/**
 * Skip reasons that the next sweep can settle at once: they compare numbers that change with each block, or (anchor not
 * stored) wait for a light client update that may land any moment.
 */
const CHEAP_REASONS: ReadonlySet<string> = new Set(["no-fee-offer", "loss-at-or-above-limit", "unpriced-tip-below-maximum", "no-price-for-fee-token", "anchor-not-stored"]);

/**
 * Skip reasons that leave a message uncovered after layout calls were paid for it: the rows that were sent did not
 * cover it, or the prover then listed a call that the try could not send. Such a try counts toward
 * `maximumUnsatisfiedPrerequisiteAttempts`.
 */
const UNCOVERED_REASONS: ReadonlySet<string> = new Set([
  "prerequisites-not-satisfied",
  "prerequisite-not-approved",
  "prerequisite-gas-above-approval",
  "prerequisite-reverted",
  "prerequisite-failed",
]);

/**
 * Skip reasons of an item that the delayed unpaid rule may still deliver: no offer, an offer below the cost, or a tip in
 * a token with no price that is under the automatic maximum (1% of the amount).
 */
const UNPAID_REASONS: ReadonlySet<string> = new Set(["no-fee-offer", "loss-at-or-above-limit", "unpriced-tip-below-maximum"]);

/** Builds the runner. It keeps in memory only caches that a restart may lose; the state file keeps what must last. */
export function createRunner(dependencies: RunnerDependencies): Runner {
  const { logger, queue } = dependencies;
  const seenPayloads = new Map<Hex, number>();
  /**
   * Items that the main pass left to the delayed unpaid rule in an earlier sweep. While they still qualify, a sweep hands
   * them to the unpaid pass without preparing them first under the normal rules, which would only find the same skip.
   */
  const unpaidCandidates = new Set<string>();
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
      acceptOracleProof: dependencies.acceptOracleProof === true,
      verifyGuard: dependencies.verifyGuard,
      verifySource: dependencies.direction,
    });
    if (!assessment.accept) {
      // A check that the budget dropped, or whose verifier gave no answer, says nothing about the proof: the message gets
      // a look when it comes again.
      if (RETRYABLE_REFUSALS.has(assessment.reason)) seenPayloads.delete(payloadKey(payload));
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
    await dependencies.onUpdatePosted?.();
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

  /** Learns what became of the update that a batch carried. */
  async function settleUpdateFate(offer: UpdateOffer | null, fate: UpdateFate): Promise<void> {
    if (offer === null || fate.kind === "not-offered") return;
    if (fate.kind === "mined") {
      const ending: UpdateEnding = fate.applied
        ? { kind: "posted", transactionHash: fate.transactionHash, gasUsed: fate.gasUsed, gasCostWei: fate.gasCostWei }
        : { kind: "skipped", reason: "update-failed", detail: `the light client reports no head update in ${fate.transactionHash}: another account may have posted first` };
      await finishUpdate(offer.message, ending);
      return;
    }
    if (fate.reason === "head-already-advanced" || fate.reason === "update-failed") {
      await finishUpdate(offer.message, { kind: "skipped", reason: fate.reason, detail: fate.detail });
      return;
    }
    logger.info("update_waits", { reason: fate.reason, detail: fate.detail, newSlot: offer.message.newSlot });
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

  /**
   * Keeps an item out of the sweeps until `milliseconds` from now. The time goes to the state file, so a restart keeps
   * it. Times that have passed are dropped on each write.
   */
  async function waitFor(messageId: string, milliseconds: number): Promise<void> {
    const now = dependencies.now();
    await dependencies.state.update((current) => ({
      ...current,
      retryAfter: { ...Object.fromEntries(Object.entries(current.retryAfter).filter(([, at]) => at > now)), [messageId]: now + milliseconds },
    }));
  }

  /** Changes the stored layout history of one message. */
  async function updateAttempt(messageId: string, change: (attempt: PrerequisiteAttempt) => PrerequisiteAttempt): Promise<void> {
    await dependencies.state.update((current) => {
      const before = current.prerequisiteAttempts[messageId] ?? { sentCalls: [], unsatisfiedAttempts: 0 };
      return { ...current, prerequisiteAttempts: { ...current.prerequisiteAttempts, [messageId]: change(before) } };
    });
  }

  /** The layout history of one message, read fresh from the state file: an earlier pass of the same sweep may have changed it. */
  async function historyOf(messageId: string): Promise<PrerequisiteHistory> {
    const stored = (await dependencies.state.load()).prerequisiteAttempts[messageId];
    return {
      sentCalls: new Set(stored?.sentCalls ?? []),
      unsatisfiedAttempts: stored?.unsatisfiedAttempts ?? 0,
      recordSent: (key) => updateAttempt(messageId, (attempt) => ({ ...attempt, sentCalls: [...new Set([...attempt.sentCalls, key])] })),
    };
  }

  async function attempt(item: FeedItem, ledger: PrerequisiteLedger, delivery: DeliveryDependencies = dependencies.delivery): Promise<Preparation | null> {
    try {
      const history = await historyOf(item.messageId);
      return await queue.run(() => prepareItem(delivery, item, ledger, history));
    } catch (error) {
      logger.error("delivery_error", { messageId: item.messageId, error });
      await waitFor(item.messageId, RETRY_AFTER_MILLISECONDS);
      return null;
    }
  }

  /** An item that waits for a batch. `spentOnPrerequisites` is true when layout calls were sent for it. */
  interface Pending {
    readonly item: FeedItem;
    readonly ready: ReadyDelivery;
    readonly spentOnPrerequisites: boolean;
  }

  /** How long the item has been deliverable, in seconds, when the delayed unpaid rule applies to it now. Null otherwise. */
  function unpaidWaitSeconds(item: FeedItem): number | null {
    const after = dependencies.delivery.settings.deliverUnpaidAfterSeconds ?? null;
    const coveredAt = item.covered?.timestamp;
    if (after === null || coveredAt === undefined) return null;
    const waited = Math.floor(dependencies.now() / 1000) - coveredAt;
    return waited >= after ? waited : null;
  }

  /** Records an outcome, counts it, schedules the next look at the item and stores a final result. An unpaid candidate is only collected in `candidates`. */
  async function settleOutcome(
    item: FeedItem,
    outcome: DeliveryOutcome,
    summary: SweepCounts,
    options: { readonly spentOnPrerequisites: boolean; readonly candidates?: FeedItem[] },
  ): Promise<void> {
    // A candidate is settled by the unpaid pass at the end of the sweep, which delivers it or says why not.
    if (options.candidates !== undefined && outcome.status === "skipped" && UNPAID_REASONS.has(outcome.reason) && unpaidWaitSeconds(item) !== null) {
      options.candidates.push(item);
      unpaidCandidates.add(item.messageId);
      return;
    }
    await record(outcome);
    if (outcome.status === "delivered") summary.delivered += 1;
    if (outcome.status === "skipped") summary.skipped += 1;
    if (outcome.status === "failed") summary.failed += 1;
    // A try that paid for layout calls and still found the message uncovered counts toward the stuck limit.
    if (outcome.status === "skipped" && UNCOVERED_REASONS.has(outcome.reason) && options.spentOnPrerequisites) {
      await updateAttempt(item.messageId, (attempt) => ({ ...attempt, unsatisfiedAttempts: attempt.unsatisfiedAttempts + 1 }));
    }
    const lossWindow = (outcome.status === "skipped" && options.spentOnPrerequisites) || (outcome.status === "skipped" && outcome.reason === "prerequisites-stuck");
    if (lossWindow) await waitFor(item.messageId, dependencies.prerequisiteLossRefusalMilliseconds);
    else if (outcome.status === "failed" || (outcome.status === "skipped" && !CHEAP_REASONS.has(outcome.reason))) await waitFor(item.messageId, RETRY_AFTER_MILLISECONDS);
    if (!isFinal(outcome)) return;
    unpaidCandidates.delete(item.messageId);
    const proof = outcome.status === "delivered" ? outcome.transactionHash : "elsewhere";
    await dependencies.state.update((current) => {
      const { [item.messageId]: _attempts, ...prerequisiteAttempts } = current.prerequisiteAttempts;
      const { [item.messageId]: _retry, ...retryAfter } = current.retryAfter;
      return { ...current, finished: { ...current.finished, [item.messageId]: proof }, prerequisiteAttempts, retryAfter };
    });
  }

  /**
   * Sends one batch. A send that throws may have broadcast the transaction, so every item of the batch counts as failed
   * and waits. The delivery reservation stays charged in the ledger. The layout calls of the items are a loss.
   */
  async function deliverBatch(
    batch: readonly Pending[],
    ledger: PrerequisiteLedger,
    summary: SweepCounts,
    update: UpdateOffer | null,
    options: { readonly candidates?: FeedItem[]; readonly delivery?: DeliveryDependencies } = {},
  ): Promise<readonly DeliveryOutcome[]> {
    let report;
    try {
      report = await queue.run(() => sendBatch(options.delivery ?? dependencies.delivery, ledger, { readies: batch.map((pending) => pending.ready), update }));
    } catch (error) {
      logger.error("delivery_batch_error", { messageIds: batch.map((pending) => pending.item.messageId), error });
      await ledger.recordLoss(batch.reduce((sum, pending) => sum + pending.ready.prerequisiteCostWei, 0n));
      for (const pending of batch) {
        summary.failed += 1;
        await waitFor(pending.item.messageId, pending.spentOnPrerequisites ? dependencies.prerequisiteLossRefusalMilliseconds : RETRY_AFTER_MILLISECONDS);
      }
      return [];
    }
    for (const [index, pending] of batch.entries()) {
      await settleOutcome(pending.item, report.outcomes[index] as DeliveryOutcome, summary, { spentOnPrerequisites: pending.spentOnPrerequisites, candidates: options.candidates });
    }
    await settleUpdateFate(update, report.update);
    return report.outcomes;
  }

  /**
   * Charges the layout calls of an unpaid try that did not deliver to the rolling cap of unpaid spend. The unpaid rule
   * sent them, so the cap bounds them too.
   */
  async function recordUnpaidLoss(messageId: string, layoutWei: bigint): Promise<void> {
    const now = dependencies.now();
    await dependencies.state.update((current) => withUnpaidSpend(current, { id: `layout:${messageId}:${now}`, atMilliseconds: now, wei: layoutWei.toString() }, now));
    logger.warn("unpaid_prerequisite_loss", { messageId, lossWei: layoutWei, chain: dependencies.destinationChainId });
  }

  /** Logs a delivery that nobody paid for and charges its receipt cost to the rolling cap. */
  async function recordUnpaid(outcome: Extract<DeliveryOutcome, { status: "delivered" }>, waitedSeconds: number): Promise<void> {
    const costWei = outcome.gasCostWei + outcome.prerequisiteCostWei;
    const now = dependencies.now();
    await dependencies.state.update((current) => withUnpaidSpend(current, { id: outcome.transactionHash, atMilliseconds: now, wei: costWei.toString() }, now));
    logger.info("delivered_unpaid", { messageId: outcome.messageId, waitedSeconds, gasUsed: outcome.gasUsed, costWei, chain: dependencies.destinationChainId });
  }

  /**
   * The delayed unpaid rule. It runs after the paid items of the sweep went out. Each candidate is a covered item that
   * waited long enough and that the normal rules left out: no offer, an offer below the cost, or a tip in a token with no
   * price under the automatic maximum. The item is prepared again with the fee check lifted (`deliverAnyTip`). An item with an offer goes to the delivery router, which pays what the offer gives
   * (the bridge alone would leave the tokens at the router); an item with none goes to the bridge. The cap of the daily
   * spend is read before each item, from the receipts, so one delivery may pass the cap and no second follows.
   */
  async function deliverUnpaid(candidates: readonly FeedItem[], ledger: PrerequisiteLedger, summary: SweepCounts): Promise<void> {
    const { settings } = dependencies.delivery;
    const unpaidDelivery: DeliveryDependencies = { ...dependencies.delivery, settings: { ...settings, deliverWithoutOffer: true, deliverAnyTip: true } };
    for (const item of candidates.slice(0, dependencies.maximumDeliveriesPerSweep)) {
      const waitedSeconds = unpaidWaitSeconds(item) as number;
      const capWei = settings.maximumUnpaidSpendPerDayWei ?? null;
      const spentWei = unpaidSpentWei(await dependencies.state.load(), dependencies.now());
      if (capWei === null || spentWei >= capWei) {
        const detail = capWei === null ? `no daily cap is set for chain ${dependencies.destinationChainId}` : `${spentWei} of ${capWei} wei spent on unpaid deliveries in the last 24 hours`;
        logger.warn("unpaid_delivery_refused", { messageId: item.messageId, reason: "daily-cap", detail, chain: dependencies.destinationChainId });
        await settleOutcome(item, skip(item.messageId as Hex, "unpaid-spend-cap", { detail }), summary, { spentOnPrerequisites: false });
        continue;
      }
      // As in the main pass, the ledger tells whether layout calls were sent for this item, and what they cost.
      const spentBefore = ledger.spentWei;
      const preparation = await attempt(item, ledger, unpaidDelivery);
      const layoutWei = ledger.spentWei - spentBefore;
      const spentOnPrerequisites = layoutWei > 0n;
      let outcome: DeliveryOutcome | undefined;
      if (preparation === null) {
        summary.failed += 1;
        // An error after a layout call was attempted: the reservation stays charged and is a loss, and the item waits out
        // the refusal window, as in the main pass.
        if (spentOnPrerequisites) {
          await ledger.recordLoss(layoutWei);
          await waitFor(item.messageId, dependencies.prerequisiteLossRefusalMilliseconds);
        }
      } else if (preparation.kind === "outcome") {
        outcome = preparation.outcome;
        await settleOutcome(item, outcome, summary, { spentOnPrerequisites });
      } else {
        const pending: Pending = { item, ready: preparation.ready, spentOnPrerequisites };
        [outcome] = await deliverBatch([pending], ledger, summary, await offerUpdate(), { delivery: unpaidDelivery });
      }
      if (outcome?.status === "delivered") await recordUnpaid(outcome, waitedSeconds);
      else if (spentOnPrerequisites) await recordUnpaidLoss(item.messageId, layoutWei);
    }
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
    const candidates: FeedItem[] = [];
    for (const item of listed) {
      if (attempts >= dependencies.maximumDeliveriesPerSweep) break;
      if ((state.retryAfter[item.messageId] ?? 0) > dependencies.now()) continue;
      // An earlier sweep found that only the unpaid rule delivers this item: it goes to the unpaid pass without a second
      // preparation under the normal rules.
      if (unpaidCandidates.has(item.messageId) && unpaidWaitSeconds(item) !== null) {
        candidates.push(item);
        continue;
      }
      const spentBefore = ledger.spentWei;
      const preparation = await attempt(item, ledger);
      const spentOnPrerequisites = ledger.spentWei > spentBefore;
      if (spentOnPrerequisites) attempts += 1;
      if (preparation === null) {
        summary.failed += 1;
        // An error after a layout call was attempted is spend-bearing: the reservation stays charged, the item counts
        // toward the sweep limit, and the item waits out the refusal window. The charge is an unrecovered loss.
        if (spentOnPrerequisites) await ledger.recordLoss(ledger.spentWei - spentBefore);
        if (spentOnPrerequisites) await waitFor(item.messageId, dependencies.prerequisiteLossRefusalMilliseconds);
        continue;
      }
      if (preparation.kind === "ready") {
        if (!spentOnPrerequisites) attempts += 1;
        waiting.push({ item, ready: preparation.ready, spentOnPrerequisites });
        continue;
      }
      const { outcome } = preparation;
      if ((outcome.status === "delivered" || outcome.status === "failed") && !spentOnPrerequisites) attempts += 1;
      await settleOutcome(item, outcome, summary, { spentOnPrerequisites, candidates });
    }
    const plan = planBatches(
      waiting.map((pending) => ({ ...pending, assumedGas: pending.ready.assumedGas })),
      { maximumBatchSize: settings.maximumBatchSize, maximumBatchGas: settings.maximumBatchGas },
    );
    // An item above the batch maximum goes alone in a transaction of its own, after the batches.
    for (const batch of [...plan.batches, ...plan.oversize.map((pending) => [pending])]) {
      await deliverBatch(batch, ledger, summary, await offerUpdate(), { candidates });
    }
    // The items that pay are done. Now the items that waited long enough without paying.
    await deliverUnpaid(candidates, ledger, summary);
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
