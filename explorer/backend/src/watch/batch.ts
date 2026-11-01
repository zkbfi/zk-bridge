/**
 * When a message proof pays, and when it is due anyway. Pure: no network, no clock.
 *
 * Owner, 2026-11-01: "or, perhaps the more reasonable thing to do is to just calculate the profit (0 on testnets) and
 * when it is profitable to do it then do it, otherwise fallback to a min wait time", and "*prove as soon as the fees of
 * finalized or soon to be finalized bridges covers the cost".
 *
 * A batch is the waiting messages of one direction that the light client does not cover yet. It pays when the fees its
 * messages carry for the fee address reach the cost of proving and delivering them: {@link PROOF_COST_USD} plus the
 * delivery gas of each message on the destination, times a margin. Dollars are integers, USD × 1e18, as in `@zkb/core`.
 */
import { PROOF_COST_USD, USD, WAD, type ProofDirection } from "@zk-bridge/shared";
import type { BackendConfig } from "../config.ts";

/** The batching of one direction, resolved from the configuration. */
export type BatchRule = {
  /** The fallback: a batch proves once its oldest message has been final this long. 0: at once, whatever it pays. */
  readonly maxWaitSeconds: number;
  /** How far ahead a message that is not final yet counts toward the time the batch is expected to pay. */
  readonly lookaheadSeconds: number;
  /** The fees must reach the cost times this (1e18 = 1). */
  readonly marginWad: bigint;
};

/** A margin as a number (1.0) to WAD, to six decimals. */
export const marginWadOf = (margin: number): bigint => BigInt(Math.round(margin * 1_000_000)) * (WAD / 1_000_000n);

/**
 * The rule of one direction: the direction's own fields beat its pair's, the pair's beat the global ones of `watch`.
 * Defaults: no wait, one epoch of lookahead, a margin of 1.
 *
 * @param epochSeconds One epoch of the source chain, in seconds: the default lookahead.
 */
export function batchRuleFor(watch: BackendConfig["watch"], pairName: string, direction: ProofDirection, epochSeconds: number): BatchRule {
  const pair = watch.pairs[pairName];
  const own = pair?.directions?.[direction];
  const pick = <Key extends "maxWaitSeconds" | "lookaheadSeconds" | "profitMargin">(key: Key) => own?.[key] ?? pair?.[key] ?? watch[key];
  return {
    maxWaitSeconds: pick("maxWaitSeconds") ?? 0,
    lookaheadSeconds: pick("lookaheadSeconds") ?? epochSeconds,
    marginWad: marginWadOf(pick("profitMargin") ?? 1),
  };
}

/**
 * What the batch is worth, read at one block. `feesUsd`: the fee each message carries for the fee address, by message
 * identifier (a message missing from it, or whose token has no price, counts nothing). `deliveryUsd`: the delivery gas
 * of one message on the destination. `unknown`: the cost or the prices could not be read, so the batch never proves
 * early.
 */
export type Economics =
  | { readonly kind: "known"; readonly feesUsd: ReadonlyMap<string, bigint>; readonly deliveryUsd: bigint; readonly unpriced: number; readonly block: string | null }
  | { readonly kind: "unknown"; readonly why: string };

/** The cost of proving and delivering `count` messages, times the margin, rounded up. */
export function batchCostUsd(count: number, deliveryUsd: bigint, marginWad: bigint): bigint {
  const cost = (PROOF_COST_USD + BigInt(count) * deliveryUsd) * marginWad;
  return (cost + WAD - 1n) / WAD;
}

/** USD × 1e18 as text with six decimals, rounded down: "0.025000". */
export function usdText(value: bigint): string {
  return `${value / USD}.${(value % USD).toString().padStart(18, "0").slice(0, 6)}`;
}

/** A message of the batch: not covered by the light client, with the time its block is expected to be final. */
export type BatchMessage = { readonly messageId: string; readonly slot: number; readonly finalAt: number };

/** The decision of {@link planBatch}. */
export type BatchPlan =
  | {
      readonly due: true;
      readonly trigger: "profit" | "max-wait";
      /** The messages that the finalized header covers: the proof covers them all. */
      readonly messageIds: readonly string[];
      readonly feesUsd: bigint | null;
      readonly costUsd: bigint | null;
      /** How long the oldest of them has been final. */
      readonly waitedSeconds: number;
    }
  | {
      readonly due: false;
      /** When the proof is expected to start: when the batch pays, or the fallback, whichever comes first. */
      readonly startAt: number;
      readonly startWhy: "profit" | "max-wait";
      /** The fallback: the oldest message final for `maxWaitSeconds`. */
      readonly maxWaitAt: number;
      /** The messages the finalized header covers now. */
      readonly ready: number;
      /** When the oldest of the batch is (or was) expected final. */
      readonly oldestFinalAt: number;
      readonly feesUsd: bigint | null;
      readonly costUsd: bigint | null;
      /** Why the batch cannot pay early, when the prices are unknown. */
      readonly unknownWhy: string | null;
    };

/** Input of {@link planBatch}. */
export type BatchInput = {
  /** The messages the light client does not cover, final or not. */
  readonly messages: readonly BatchMessage[];
  readonly finalizedSlot: number;
  readonly nowSeconds: number;
  readonly rule: BatchRule;
  readonly economics: Economics;
};

/**
 * Whether the batch proves now, and if not, when it is expected to.
 *
 * - Due when the finalized header covers at least one message and either their fees reach the cost (`profit`), or
 *   the oldest of them has been final for `maxWaitSeconds` (`max-wait`; at once when that is 0).
 * - Otherwise the proof is expected at the first expected finality, within the lookahead, at which the fees of the
 *   messages final by then reach the cost of proving them all; else at the fallback. A message that is not final is
 *   counted for this time only: a proof can only target a finalized header.
 *
 * Null when no message waits.
 */
export function planBatch(input: BatchInput): BatchPlan | null {
  const { rule, economics, nowSeconds } = input;
  if (input.messages.length === 0) return null;
  const byFinality = [...input.messages].sort((left, right) => left.finalAt - right.finalAt || (left.messageId < right.messageId ? -1 : 1));
  const ready = byFinality.filter((message) => message.slot <= input.finalizedSlot);
  const upcoming = byFinality.filter((message) => message.slot > input.finalizedSlot);
  const oldestFinalAt = Math.min(...(ready.length > 0 ? ready : upcoming).map((message) => message.finalAt));
  const maxWaitAt = oldestFinalAt + rule.maxWaitSeconds;
  const known = economics.kind === "known" ? economics : null;
  const feeOf = (message: BatchMessage) => known?.feesUsd.get(message.messageId) ?? 0n;
  const costOf = (count: number) => (known === null ? null : batchCostUsd(count, known.deliveryUsd, rule.marginWad));
  const feesUsd = known === null ? null : ready.reduce((sum, message) => sum + feeOf(message), 0n);
  const costUsd = costOf(ready.length);
  if (ready.length > 0) {
    const paid = feesUsd !== null && costUsd !== null && feesUsd >= costUsd;
    if (paid || rule.maxWaitSeconds === 0 || nowSeconds >= maxWaitAt) {
      return {
        due: true,
        trigger: paid ? "profit" : "max-wait",
        messageIds: ready.map((message) => message.messageId),
        feesUsd,
        costUsd,
        waitedSeconds: Math.max(0, Math.round(nowSeconds - oldestFinalAt)),
      };
    }
  }
  let profitAt: number | null = null;
  if (known !== null) {
    let fees = feesUsd as bigint;
    let count = ready.length;
    for (const message of upcoming) {
      if (message.finalAt > nowSeconds + rule.lookaheadSeconds) break;
      fees += feeOf(message);
      count += 1;
      if (fees >= (costOf(count) as bigint)) {
        profitAt = message.finalAt;
        break;
      }
    }
  }
  const early = profitAt !== null && profitAt < maxWaitAt;
  return {
    due: false,
    startAt: early ? (profitAt as number) : maxWaitAt,
    startWhy: early ? "profit" : "max-wait",
    maxWaitAt,
    ready: ready.length,
    oldestFinalAt,
    feesUsd,
    costUsd,
    unknownWhy: economics.kind === "unknown" ? economics.why : null,
  };
}
