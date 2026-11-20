/**
 * When a message proof pays, and when it is due anyway. Pure: no network, no clock.
 *
 * Owner, 2026-11-01: "or, perhaps the more reasonable thing to do is to just calculate the profit (0 on testnets) and
 * when it is profitable to do it then do it, otherwise fallback to a min wait time", and "*prove as soon as the fees of
 * finalized or soon to be finalized bridges covers the cost".
 *
 * Owner, later on 2026-11-01: "it seems like you do not have the requisite logic in place to check the following: is
 * there a bridge? is it profitable? has it been an hour", and "no, the last proof was in a previous hour". So the
 * fallback counts from the direction's last proof, not from the oldest message: a message that arrives long after the
 * last proof proves at its finality.
 *
 * A batch is the waiting messages of one direction that the light client does not cover yet. It pays when the fees its
 * messages carry for the fee address reach the cost of proving and delivering them: `PROOF_COST_USD` (`@zkb/core`, as `batchCostUsd`) plus the
 * delivery gas of each message on the destination, times a margin. Dollars are integers, USD × 1e18, as in `@zkb/core`.
 *
 * A message whose token has no price cannot be valued; its tip pays when it is at least the frontend's automatic
 * maximum, 1% of the amount (`tipVerdict` of `@zkb/core`, the rule the runner and the dapp use too), and such a message
 * makes its batch pay: the batch proves at its finality (owner, 2026-11-09: "yes, deliver straight away"). With
 * `unpricedAtMaximumPays: false` (owner, 2026-11-13: testnet transfers share one light-client update an hour) such a
 * message does not make its batch pay; it waits for the interval like any other.
 */
import { USD, batchCostUsd, batchDueAt, intervalAllows, marginWadOf, type ProofDirection } from "@zk-bridge/shared";
import type { BackendConfig } from "../config.ts";

/** The batching of one direction, resolved from the configuration. */
export type BatchRule = {
  /**
   * The fallback: a batch that does not pay proves once the direction's last proof started at least this long ago.
   * 0: at once, whatever it pays.
   */
  readonly minIntervalSeconds: number;
  /** How far ahead a message that is not final yet counts toward the time the batch is expected to pay. */
  readonly lookaheadSeconds: number;
  /** The fees must reach the cost times this (1e18 = 1). */
  readonly marginWad: bigint;
  /**
   * Whether a message with no price for its token and a tip at the automatic maximum makes the batch pay. False: it
   * counts as any unpriced message and the batch waits for `minIntervalSeconds`. Priced fees count either way.
   */
  readonly unpricedAtMaximumPays: boolean;
};

/** The batch fields of one level of `watch`: the global ones, a pair's, or a direction's. */
type BatchLevel = { readonly minIntervalSeconds?: number | undefined; readonly maxWaitSeconds?: number | undefined; readonly lookaheadSeconds?: number | undefined; readonly profitMargin?: number | undefined; readonly unpricedAtMaximumPays?: boolean | undefined };

/** The minimum interval a level names: `minIntervalSeconds`, else its deprecated alias `maxWaitSeconds`. */
export const intervalOf = (level: BatchLevel | undefined) => level?.minIntervalSeconds ?? level?.maxWaitSeconds;

/**
 * The rule of one direction: the direction's own fields beat its pair's, the pair's beat the global ones of `watch`.
 * On one level `minIntervalSeconds` beats its deprecated alias `maxWaitSeconds`. Defaults: no minimum interval, one
 * epoch of lookahead, a margin of 1.
 *
 * @param epochSeconds One epoch of the source chain, in seconds: the default lookahead.
 */
export function batchRuleFor(watch: BackendConfig["watch"], pairName: string, direction: ProofDirection, epochSeconds: number): BatchRule {
  const pair = watch.pairs[pairName];
  const own = pair?.directions?.[direction];
  const pick = <Key extends "lookaheadSeconds" | "profitMargin" | "unpricedAtMaximumPays">(key: Key) => own?.[key] ?? pair?.[key] ?? watch[key];
  return {
    minIntervalSeconds: intervalOf(own) ?? intervalOf(pair) ?? intervalOf(watch) ?? 0,
    lookaheadSeconds: pick("lookaheadSeconds") ?? epochSeconds,
    marginWad: marginWadOf(pick("profitMargin") ?? 1),
    unpricedAtMaximumPays: pick("unpricedAtMaximumPays") ?? true,
  };
}

/**
 * Whether the direction may prove as the companion of the other direction's proof (`companionProofs`), resolved as
 * {@link batchRuleFor} resolves its fields: the direction's beats its pair's, the pair's beats the global one. Default
 * true.
 */
export function companionProofsFor(watch: BackendConfig["watch"], pairName: string, direction: ProofDirection): boolean {
  const pair = watch.pairs[pairName];
  return pair?.directions?.[direction]?.companionProofs ?? pair?.companionProofs ?? watch.companionProofs ?? true;
}

/** The configuration keys that use the deprecated `maxWaitSeconds`, such as `watch.pairs.sepolia-pls943.maxWaitSeconds`. */
export function deprecatedBatchKeys(watch: BackendConfig["watch"]): string[] {
  const keys: string[] = [];
  const visit = (level: BatchLevel | undefined, path: string) => {
    if (level?.maxWaitSeconds !== undefined) keys.push(`${path}.maxWaitSeconds`);
  };
  visit(watch, "watch");
  for (const [name, pair] of Object.entries(watch.pairs)) {
    visit(pair, `watch.pairs.${name}`);
    for (const [direction, own] of Object.entries(pair?.directions ?? {})) visit(own, `watch.pairs.${name}.directions.${direction}`);
  }
  return keys;
}

/**
 * What the batch is worth, read at one block. `feesUsd`: the fee each priced message carries for the fee address, by
 * message identifier (a message missing from it counts nothing). `atMaximum`: the messages whose token has no price and
 * whose tip is at least the automatic maximum (1% of the amount): each makes its batch pay. `unpriced`: the messages
 * whose token has no price and whose tip is below that. `deliveryUsd`: the delivery gas of one message on the
 * destination, null when the destination's coin has no price (then `why` says why, and no fee is valued). `unknown`:
 * the messages could not be read, so the batch never proves early.
 */
export type Economics =
  | {
      readonly kind: "known";
      readonly feesUsd: ReadonlyMap<string, bigint>;
      readonly deliveryUsd: bigint | null;
      readonly unpriced: number;
      readonly atMaximum: ReadonlySet<string>;
      readonly why: string | null;
      readonly block: string | null;
    }
  | { readonly kind: "unknown"; readonly why: string };

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
      readonly trigger: "profit" | "interval";
      /** The messages that the finalized header covers: the proof covers them all. */
      readonly messageIds: readonly string[];
      readonly feesUsd: bigint | null;
      readonly costUsd: bigint | null;
      /** The messages of the proof whose tip pays at the automatic maximum (no price for their token). */
      readonly atMaximum: number;
      /** How long the oldest of them has been final. */
      readonly waitedSeconds: number;
    }
  | {
      readonly due: false;
      /** When the proof is expected to start: when the batch pays, or the fallback, whichever comes first. */
      readonly startAt: number;
      readonly startWhy: "profit" | "interval";
      /**
       * The fallback: `minIntervalSeconds` after the last proof started, and no earlier than the first finality of a
       * message of the batch (a proof needs a final message).
       */
      readonly dueAt: number;
      /** When the direction's last proof started, or null when it has none. */
      readonly lastProofAt: number | null;
      /** The messages the finalized header covers now. */
      readonly ready: number;
      /** When the oldest of the batch is (or was) expected final. */
      readonly oldestFinalAt: number;
      readonly feesUsd: bigint | null;
      readonly costUsd: bigint | null;
      /** Why the fees cannot be valued, when they cannot (a tip at the automatic maximum still pays). */
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
  /** When the direction's last proof job started (any reason: a message, a handoff, a keep-alive), or null for none. */
  readonly lastProofAt: number | null;
};

/**
 * Whether the batch proves now, and if not, when it is expected to.
 *
 * - Due when the finalized header covers at least one message and either their fees reach the cost, or one of them
 *   has no price and a tip at the automatic maximum (`profit`), or the direction's last proof started at least
 *   `minIntervalSeconds` ago (`interval`; at once when that is 0 or the direction has no proof yet).
 * - Otherwise the proof is expected at the first expected finality, within the lookahead, at which the fees of the
 *   messages final by then reach the cost of proving them all, or a message with a tip at the automatic maximum is
 *   final; else at the fallback (`dueAt`). A message that is not final is counted for this time only: a proof can only
 *   target a finalized header.
 *
 * Null when no message waits: with nothing to carry, the interval never starts a proof.
 */
export function planBatch(input: BatchInput): BatchPlan | null {
  const { rule, economics, nowSeconds } = input;
  if (input.messages.length === 0) return null;
  const byFinality = [...input.messages].sort((left, right) => left.finalAt - right.finalAt || (left.messageId < right.messageId ? -1 : 1));
  const ready = byFinality.filter((message) => message.slot <= input.finalizedSlot);
  const upcoming = byFinality.filter((message) => message.slot > input.finalizedSlot);
  const oldestFinalAt = Math.min(...(ready.length > 0 ? ready : upcoming).map((message) => message.finalAt));
  const dueAt = batchDueAt(oldestFinalAt, input.lastProofAt, rule.minIntervalSeconds);
  const known = economics.kind === "known" ? economics : null;
  const priced = known !== null && known.deliveryUsd !== null ? { feesUsd: known.feesUsd, deliveryUsd: known.deliveryUsd } : null;
  const atMaximum = (message: BatchMessage): boolean => rule.unpricedAtMaximumPays && known?.atMaximum.has(message.messageId) === true;
  const feeOf = (message: BatchMessage) => priced?.feesUsd.get(message.messageId) ?? 0n;
  const costOf = (count: number) => (priced === null ? null : batchCostUsd(count, priced.deliveryUsd, rule.marginWad));
  const feesUsd = priced === null ? null : ready.reduce((sum, message) => sum + feeOf(message), 0n);
  const costUsd = costOf(ready.length);
  if (ready.length > 0) {
    const readyAtMaximum = ready.filter(atMaximum).length;
    const paid = readyAtMaximum > 0 || (feesUsd !== null && costUsd !== null && feesUsd >= costUsd);
    if (paid || intervalAllows(nowSeconds, input.lastProofAt, rule.minIntervalSeconds)) {
      return {
        due: true,
        trigger: paid ? "profit" : "interval",
        messageIds: ready.map((message) => message.messageId),
        feesUsd,
        costUsd,
        atMaximum: readyAtMaximum,
        waitedSeconds: Math.max(0, Math.round(nowSeconds - oldestFinalAt)),
      };
    }
  }
  let profitAt: number | null = null;
  if (known !== null) {
    let fees = feesUsd ?? 0n;
    let count = ready.length;
    for (const message of upcoming) {
      if (message.finalAt > nowSeconds + rule.lookaheadSeconds) break;
      fees += feeOf(message);
      count += 1;
      const cost = costOf(count);
      if (atMaximum(message) || (cost !== null && fees >= cost)) {
        profitAt = message.finalAt;
        break;
      }
    }
  }
  const early = profitAt !== null && profitAt < dueAt;
  return {
    due: false,
    startAt: early ? (profitAt as number) : dueAt,
    startWhy: early ? "profit" : "interval",
    dueAt,
    lastProofAt: input.lastProofAt,
    ready: ready.length,
    oldestFinalAt,
    feesUsd,
    costUsd,
    unknownWhy: economics.why,
  };
}
