import { parseUnits, type Address } from "viem";
import type { TrafficTokenConfig } from "../config/bot-config.ts";

/**
 * The choice of the next test transfer. Pure: it reads balances and a random source, and returns a transfer or the reason
 * that none goes.
 */

/** A lower and an upper bound in base units. */
export interface Bounds {
  readonly minimum: bigint;
  readonly maximum: bigint;
}

/** The settings of one symbol, in base units of its token. */
export interface TokenBounds {
  readonly amount: Bounds;
  readonly balance: Bounds;
}

/** Turns the whole token amounts of the configuration into base units. */
export function boundsOf(settings: TrafficTokenConfig, decimals: number): TokenBounds {
  const read = (text: string) => parseUnits(text, decimals);
  return {
    amount: { minimum: read(settings.amount.minimum), maximum: read(settings.amount.maximum) },
    balance: { minimum: read(settings.balance.minimum), maximum: read(settings.balance.maximum) },
  };
}

/**
 * What can move from the source chain. A `native` candidate is a test token whose home is the source chain: it goes out,
 * and the destination gets its copy. A `copy` candidate is the bridged copy of a test token whose home is the destination:
 * it goes home.
 */
export interface Candidate {
  readonly symbol: string;
  readonly kind: "native" | "copy";
  readonly decimals: number;
  /** The token that the wallet sends, on the source chain. */
  readonly sourceToken: Address;
  /** The token that the delivery pays out, on the destination chain. */
  readonly destinationToken: Address;
  /** The wallet's balance of `sourceToken`. */
  readonly sourceBalance: bigint;
  /** The wallet's balance of the native token on its home chain. For a native candidate it equals `sourceBalance`. */
  readonly homeBalance: bigint;
  readonly bounds: TokenBounds;
}

/** Why a candidate cannot go now. */
export type IneligibleReason = "home-balance-at-minimum" | "copy-balance-below-amount";

/** The chosen transfer, or why none goes. */
export type Pick =
  | { readonly kind: "send"; readonly candidate: Candidate; readonly amount: bigint; readonly priority: boolean }
  | {
      readonly kind: "skip";
      readonly reason: "no-eligible-token";
      readonly candidates: readonly { readonly symbol: string; readonly kind: Candidate["kind"]; readonly reason: IneligibleReason }[];
    };

/** A source of numbers from 0 (included) to 1 (excluded), as `Math.random`. */
export type Random = () => number;

/** Draws an index from 0 to `count - 1`. */
function drawIndex(count: number, random: Random): number {
  return Math.min(count - 1, Math.floor(random() * count));
}

/**
 * Draws an amount between the bounds, in steps of one hundredth of a whole token (one base unit for a token with fewer
 * than two decimals), so the amounts read well in an explorer.
 */
export function drawAmount(bounds: Bounds, decimals: number, random: Random): bigint {
  const step = 10n ** BigInt(Math.max(decimals - 2, 0));
  const low = (bounds.minimum + step - 1n) / step;
  const high = bounds.maximum / step;
  if (high < low) return bounds.minimum;
  const span = high - low + 1n;
  // A span above 2^53 loses only the low bits of the draw, which is fine for test traffic.
  const offset = BigInt(Math.floor(random() * Number(span)));
  return (low + (offset < span ? offset : span - 1n)) * step;
}

/**
 * Picks the transfer of one send. Each candidate draws its amount (a copy never more than its balance) and is eligible
 * when
 *
 * - native: the home balance stays at or above the minimum of its band after the send;
 * - copy: its balance reaches the smallest amount.
 *
 * Candidates that pull a balance back into its band go first: a native token whose home balance is above the band, and a
 * copy whose native token is below the band at home. Among the candidates of the first group that has any, the pick is
 * uniform.
 */
export function pickTransfer(candidates: readonly Candidate[], random: Random): Pick {
  const eligible: { candidate: Candidate; amount: bigint; priority: boolean }[] = [];
  const refused: { symbol: string; kind: Candidate["kind"]; reason: IneligibleReason }[] = [];
  for (const candidate of candidates) {
    const drawn = drawAmount(candidate.bounds.amount, candidate.decimals, random);
    if (candidate.kind === "native") {
      if (candidate.sourceBalance < drawn || candidate.sourceBalance - drawn < candidate.bounds.balance.minimum) {
        refused.push({ symbol: candidate.symbol, kind: candidate.kind, reason: "home-balance-at-minimum" });
        continue;
      }
      eligible.push({ candidate, amount: drawn, priority: candidate.homeBalance > candidate.bounds.balance.maximum });
      continue;
    }
    if (candidate.sourceBalance === 0n || candidate.sourceBalance < candidate.bounds.amount.minimum) {
      refused.push({ symbol: candidate.symbol, kind: candidate.kind, reason: "copy-balance-below-amount" });
      continue;
    }
    eligible.push({ candidate, amount: drawn < candidate.sourceBalance ? drawn : candidate.sourceBalance, priority: candidate.homeBalance < candidate.bounds.balance.minimum });
  }
  if (eligible.length === 0) return { kind: "skip", reason: "no-eligible-token", candidates: refused };
  const urgent = eligible.filter((entry) => entry.priority);
  const pool = urgent.length > 0 ? urgent : eligible;
  const chosen = pool[drawIndex(pool.length, random)] as (typeof pool)[number];
  return { kind: "send", candidate: chosen.candidate, amount: chosen.amount, priority: chosen.priority };
}
