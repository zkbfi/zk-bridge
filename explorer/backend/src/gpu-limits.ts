/**
 * The GPU limits that follow a pair's proving interval (docs/superpowers/specs/2026-11-18-two-pairs-gas-and-proving-design.md,
 * decision 3). Pure: no network, no clock.
 *
 * A pair proves a direction at most every `minIntervalSeconds`, so it asks for at most `proofsPerHour = ceil(3600 / interval)`
 * proofs an hour in each direction (an interval of 0 counts as 60 seconds). Each proof costs about `proofCostUsd` (0.10: the
 * measured cost on 2026-11-18 was about 0.06 including the cold start), and `headroom` (2) covers keep-alives, urgent proofs
 * and a retry. Both limits default to what that costs, never below the figures the backend used before:
 *   - `gpuGuard.maxUsdPerHour` (per tier): `max(0.5, 2 directions x proofsPerHour x proofCostUsd x headroom)`. Both directions
 *     can land on the same tier in the tier race.
 *   - `limits.gpuBudgetUsdPerDirectionPerDay`: `max(5, 24 x proofsPerHour x proofCostUsd x headroom)`.
 * With no interval set anywhere (neither the pair nor `watch`) nothing is derived and the floors stay. A value in the file wins. An hourly pair (3600 s) derives 0.5 and 5, the figures that were fixed before; a 600 s pair
 * derives 2.40 and 28.80.
 */
import { intervalOf } from "./watch/batch.ts";
import type { Logger } from "./logger.ts";

/** What the limits were before they followed the interval, and so the least they ever are. */
export const MAX_USD_PER_HOUR_FLOOR = 0.5;
export const BUDGET_USD_PER_DIRECTION_PER_DAY_FLOOR = 5;
/** Both directions of a pair may land on the same tier. */
const DIRECTIONS = 2;
const ZERO_INTERVAL_SECONDS = 60;

/** One limit in force: its value, the figure the interval derives, and where the value came from. */
export type GpuLimit = { readonly value: number; readonly derived: number; readonly source: "derived" | "set" };

export type GpuLimits = {
  /** The pair's minimum interval, in seconds; null when neither the pair nor `watch` sets one. */
  readonly intervalSeconds: number | null;
  readonly proofsPerHour: number;
  readonly proofCostUsd: number;
  readonly headroom: number;
  readonly maxUsdPerHour: GpuLimit;
  readonly gpuBudgetUsdPerDirectionPerDay: GpuLimit;
};

/** The proofs an hour that one direction can start with this interval. */
export function proofsPerHour(intervalSeconds: number): number {
  return Math.ceil(3600 / (intervalSeconds === 0 ? ZERO_INTERVAL_SECONDS : intervalSeconds));
}

/** Rounds away float noise (1.2000000000000002) to four places. */
const round = (value: number) => Math.round(value * 10_000) / 10_000;

type Level = Parameters<typeof intervalOf>[0];

export function deriveGpuLimits(input: {
  /** `watch` of the configuration: the pair's level, then the watch level, as `batchRuleFor` reads them. */
  readonly watch: Level & { readonly pairs?: Readonly<Record<string, Level>> | undefined };
  readonly pair: string;
  readonly proofCostUsd: number;
  readonly headroom: number;
  /** The values the file sets, if any. */
  readonly explicit: { readonly maxUsdPerHour?: number | undefined; readonly gpuBudgetUsdPerDirectionPerDay?: number | undefined };
}): GpuLimits {
  const intervalSeconds = intervalOf(input.watch.pairs?.[input.pair]) ?? intervalOf(input.watch) ?? null;
  // No interval anywhere: there is nothing to derive from, so the limits stay at the figures they had before (the floors).
  const perHour = proofsPerHour(intervalSeconds ?? 3600);
  const hourlyDerived = round(Math.max(MAX_USD_PER_HOUR_FLOOR, DIRECTIONS * perHour * input.proofCostUsd * input.headroom));
  const dailyDerived = round(Math.max(BUDGET_USD_PER_DIRECTION_PER_DAY_FLOOR, 24 * perHour * input.proofCostUsd * input.headroom));
  const limit = (explicit: number | undefined, derived: number): GpuLimit => (explicit === undefined ? { value: derived, derived, source: "derived" } : { value: explicit, derived, source: "set" });
  return {
    intervalSeconds,
    proofsPerHour: perHour,
    proofCostUsd: input.proofCostUsd,
    headroom: input.headroom,
    maxUsdPerHour: limit(input.explicit.maxUsdPerHour, hourlyDerived),
    gpuBudgetUsdPerDirectionPerDay: limit(input.explicit.gpuBudgetUsdPerDirectionPerDay, dailyDerived),
  };
}

/**
 * Logs the limits in force at start-up, each as derived or set, and one `gpu_limits_below_interval` warning for each value
 * that the file sets below what the interval derives. The backend runs with the value it was given.
 */
export function logGpuLimits(logger: Logger, limits: GpuLimits): void {
  logger.info("gpu_limits", {
    intervalSeconds: limits.intervalSeconds,
    proofsPerHour: limits.proofsPerHour,
    proofCostUsd: limits.proofCostUsd,
    headroom: limits.headroom,
    maxUsdPerHour: limits.maxUsdPerHour.value,
    maxUsdPerHourSource: limits.maxUsdPerHour.source,
    gpuBudgetUsdPerDirectionPerDay: limits.gpuBudgetUsdPerDirectionPerDay.value,
    gpuBudgetSource: limits.gpuBudgetUsdPerDirectionPerDay.source,
  });
  const entries = [
    ["gpuGuard.maxUsdPerHour", limits.maxUsdPerHour],
    ["limits.gpuBudgetUsdPerDirectionPerDay", limits.gpuBudgetUsdPerDirectionPerDay],
  ] as const;
  for (const [key, limit] of entries) {
    if (limit.source === "set" && limit.value < limit.derived) {
      logger.warn("gpu_limits_below_interval", { key, set: limit.value, derived: limit.derived, intervalSeconds: limits.intervalSeconds, detail: `${key} is ${limit.value}, below the ${limit.derived} that a ${limits.intervalSeconds} s interval can spend; a busy period may trip the guard or the budget` });
    }
  }
}
