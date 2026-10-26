import type { Address, Hex } from "viem";
import type { ProofDirection } from "@zk-bridge/shared";
import type { LightClientReader } from "../chain/light-client.ts";
import type { FeedItem } from "../indexer/client.ts";
import type { Logger } from "../logging/logger.ts";
import type { StateFile } from "../runtime/state-file.ts";
import { createPrerequisiteLedger, deliverItem, isFinal, type PrerequisiteLedger, type DeliveryDependencies, type DeliveryOutcome } from "./delivery.ts";
import type { OutcomeSink } from "./outcomes.ts";
import { assessProofPayload, payloadKey, type ProofRefusal } from "./proof-intake.ts";
import type { SerialQueue } from "./serial-queue.ts";
import type { RunnerState } from "./state.ts";
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
  readonly state: StateFile<RunnerState>;
  readonly outcomes: OutcomeSink;
  readonly queue: SerialQueue;
  readonly now: () => number;
  /** The most deliveries a sweep tries. A sweep that spent gas on layout calls counts for one, also when it skipped. */
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

/** Skip reasons that the next sweep can settle at once, because they only compare numbers that change with each block. */
const CHEAP_REASONS: ReadonlySet<string> = new Set(["no-fee-offer", "fee-below-cost-plus-margin", "no-price-for-fee-token"]);

/** Builds the runner. It keeps in memory only caches that a restart may lose; the state file keeps what must last. */
export function createRunner(dependencies: RunnerDependencies): Runner {
  const { logger, queue } = dependencies;
  const seenPayloads = new Map<Hex, number>();
  const retryAfter = new Map<string, number>();
  const lastSkipReason = new Map<string, string>();
  const base = { pair: dependencies.pairName, direction: dependencies.direction };

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
    const outcome = await queue.run(() => postUpdate({ chain: dependencies.delivery.chain, lightClient: dependencies.lightClientAddress, message }));
    if (!outcome.posted) {
      logger.info("update_skipped", { reason: outcome.reason, detail: outcome.detail, newSlot: message.newSlot });
      await dependencies.outcomes.record({ kind: "update", ...base, status: "skipped", reason: outcome.reason, detail: outcome.detail, startSlot: message.startSlot, newSlot: message.newSlot });
      return { handled: "update-skipped", reason: outcome.reason, detail: outcome.detail };
    }
    logger.info("update_posted", { transactionHash: outcome.transactionHash, newSlot: message.newSlot, gasUsed: outcome.gasUsed });
    await dependencies.outcomes.record({
      kind: "update",
      ...base,
      status: "posted",
      transactionHash: outcome.transactionHash,
      startSlot: message.startSlot,
      newSlot: message.newSlot,
      gasUsed: outcome.gasUsed,
      gasCostWei: outcome.gasUsed * outcome.effectiveGasPrice,
    });
    return { handled: "update-posted", transactionHash: outcome.transactionHash };
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

  async function attempt(item: FeedItem, ledger: PrerequisiteLedger): Promise<DeliveryOutcome | null> {
    try {
      return await queue.run(() => deliverItem(dependencies.delivery, item, ledger));
    } catch (error) {
      logger.error("delivery_error", { messageId: item.messageId, error });
      retryAfter.set(item.messageId, dependencies.now() + RETRY_AFTER_MILLISECONDS);
      return null;
    }
  }

  async function sweep(): Promise<SweepSummary> {
    const state = await dependencies.state.load();
    const finished = new Set(Object.keys(state.finished));
    const listed = await listCovered(finished);
    const summary = { listed: listed.length, delivered: 0, skipped: 0, failed: 0 };
    const ledger = createPrerequisiteLedger(dependencies.delivery.settings.maximumPrerequisiteSpendPerSweepWei);
    let attempts = 0;
    for (const item of listed) {
      if (attempts >= dependencies.maximumDeliveriesPerSweep) break;
      if ((retryAfter.get(item.messageId) ?? 0) > dependencies.now()) continue;
      const spentBefore = ledger.spentWei;
      const outcome = await attempt(item, ledger);
      const spentOnPrerequisites = ledger.spentWei > spentBefore;
      if (spentOnPrerequisites) attempts += 1;
      if (outcome === null) {
        summary.failed += 1;
        if (spentOnPrerequisites) retryAfter.set(item.messageId, dependencies.now() + dependencies.prerequisiteLossRefusalMilliseconds);
        continue;
      }
      if ((outcome.status === "delivered" || outcome.status === "failed") && !spentOnPrerequisites) attempts += 1;
      await record(outcome);
      if (outcome.status === "delivered") summary.delivered += 1;
      if (outcome.status === "skipped") summary.skipped += 1;
      if (outcome.status === "failed") summary.failed += 1;
      if (outcome.status === "skipped" && !CHEAP_REASONS.has(outcome.reason)) retryAfter.set(item.messageId, dependencies.now() + RETRY_AFTER_MILLISECONDS);
      if (outcome.status === "failed") retryAfter.set(item.messageId, dependencies.now() + RETRY_AFTER_MILLISECONDS);
      if (outcome.status === "skipped" && spentOnPrerequisites) retryAfter.set(item.messageId, dependencies.now() + dependencies.prerequisiteLossRefusalMilliseconds);
      if (isFinal(outcome)) {
        const proof = outcome.status === "delivered" ? outcome.transactionHash : "elsewhere";
        const current = await dependencies.state.load();
        await dependencies.state.save({ ...current, finished: { ...current.finished, [item.messageId]: proof } });
      }
    }
    return summary;
  }

  return { handleProofPayload, sweep };
}
