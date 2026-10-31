/**
 * How long a transfer takes, end to end and at each of the in-flight steps (Sent, Final, Proof ready), from the
 * timestamps the indexer stores. The indexer computes the same figures in SQL (`GET /api/delivered`); this module is
 * the definition, and the tests pin it.
 *
 * For a delivered message:
 *
 * - sent: `sentTimestamp`, the source block's time.
 * - final: sent + the source chain's finality window (`finalitySeconds` of the pair side), the moment the indexer's
 *   status turns from `sent` to `waiting_for_finality`.
 * - ready: when a valid proof covered it, as far as the indexer knows: the time a stored head covered it
 *   (`coveredAtTimestamp`), or the delivery itself when no head covered it first (a delivery posts its own proof). The
 *   indexer does not keep when a proof first showed up on the board, so "ready" can be later than a deliverer could
 *   have known; the Final step then reads longer and Proof ready shorter.
 * - delivered: `deliveredTimestamp`.
 *
 * Steps: Sent = min(final, ready) − sent; Final = max(0, ready − final); Proof ready = delivered − ready; and
 * sent → delivered = delivered − sent. A covering time after the delivery counts as the delivery.
 */

/** The timestamps of one delivered message, in seconds. */
export type TransferTimes = {
  readonly sentAt: number;
  readonly coveredAt: number | null;
  readonly deliveredAt: number;
  readonly finalitySeconds: number;
};

/** Seconds at each step and end to end. */
export type StepDurations = { readonly sent: number; readonly final: number; readonly ready: number; readonly total: number };

/**
 * A delivered message's seconds at each step.
 *
 * @param times Its timestamps and its source chain's finality window.
 */
export const stepDurations = (times: TransferTimes): StepDurations => {
  const final = times.sentAt + times.finalitySeconds;
  const ready = times.coveredAt === null ? times.deliveredAt : Math.min(times.coveredAt, times.deliveredAt);
  return {
    sent: Math.max(0, Math.min(final, ready) - times.sentAt),
    final: Math.max(0, ready - final),
    ready: Math.max(0, times.deliveredAt - ready),
    total: Math.max(0, times.deliveredAt - times.sentAt),
  };
};

/**
 * A quantile with linear interpolation between the closest ranks, as SQL's `percentile_cont` computes it; null for
 * no values.
 *
 * @param values The values, any order.
 * @param q The quantile, 0 to 1 (0.5 the median, 0.9 the 90th percentile).
 */
export const quantile = (values: readonly number[], q: number): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = q * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  return sorted[low]! + (sorted[high]! - sorted[low]!) * (rank - low);
};

/** Average, median and 90th percentile, each null for no values. */
export type TimingStats = { readonly count: number; readonly avg: number | null; readonly median: number | null; readonly p90: number | null };

/**
 * The stats of some durations.
 *
 * @param values Seconds.
 */
export const timingStats = (values: readonly number[]): TimingStats => ({
  count: values.length,
  avg: values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length,
  median: quantile(values, 0.5),
  p90: quantile(values, 0.9),
});
