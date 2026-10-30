/**
 * The loader is the swirl (public/loader.svg): the word zkb.fi winding into the mark. It is plain markup in
 * index.html, so it shows before any script runs. The page waits for the first swirl to finish before it replaces the
 * loader, so the viewer sees the mark form instead of a cut-off frame.
 */

/** The swirl ends on the mark 1.44 s after it starts; this leaves a frame of the finished mark. */
export const SWIRL_MILLISECONDS = 1500;

/** The page never waits longer than this for the swirl, however late the loader image arrived. */
export const MAXIMUM_HOLD_MILLISECONDS = 2000;

/** What {@link loaderHoldMilliseconds} reads. */
export type LoaderClock = {
  /** `performance.now()` when the page is ready to show. */
  readonly nowMs: number;
  /** `performance.now()` when the loader image arrived (its swirl starts then), or null when that is unknown. */
  readonly loaderStartMs: number | null;
  /** The viewer asked for reduced motion: the loader is the still mark, so there is nothing to wait for. */
  readonly reducedMotion: boolean;
};

/**
 * How long the page waits before it replaces the loader: until the first swirl has ended, at most
 * {@link MAXIMUM_HOLD_MILLISECONDS}, and not at all for reduced motion.
 *
 * @param clock The times and the motion preference.
 */
export const loaderHoldMilliseconds = ({ nowMs, loaderStartMs, reducedMotion }: LoaderClock): number => {
  if (reducedMotion) return 0;
  const start = loaderStartMs ?? 0;
  return Math.min(MAXIMUM_HOLD_MILLISECONDS, Math.max(0, start + SWIRL_MILLISECONDS - nowMs));
};

/** When the loader image arrived, from the resource timing of the page, or null. */
export const loaderStartFromTiming = (entries: readonly { readonly name: string; readonly responseEnd: number }[]): number | null => {
  const entry = entries.find((candidate) => /\/loader\.svg(\?|$)/.test(candidate.name));
  return entry === undefined ? null : entry.responseEnd;
};
