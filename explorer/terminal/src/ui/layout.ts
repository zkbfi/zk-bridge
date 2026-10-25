/**
 * The layout of the pair view as a function of the terminal size. It is pure, so a test can check it for any size.
 *
 * Three sizes. `wide` has room for every column and detail. `compact` fits 80 columns by 24 rows with every area and
 * every timestamp, and drops secondary columns. `tooSmall` shows a message instead of a broken screen.
 */

/** The size classes. */
export type LayoutMode = 'wide' | 'compact' | 'tooSmall'

/** The smallest terminal that shows the dashboard. */
export const MINIMUM_WIDTH = 78
/** The smallest terminal height that shows the dashboard. */
export const MINIMUM_HEIGHT = 22

/** Where each area goes. All sizes are in terminal cells. */
export interface PairLayout {
  readonly mode: LayoutMode
  readonly width: number
  readonly height: number
  /** Rows of the summary area, including its border. */
  readonly summaryHeight: number
  /** Rows of the footer with the light client heads, including its border. */
  readonly headsHeight: number
  /** Width of the action area, including its border. */
  readonly actionWidth: number
  /** Content lines of the filter header (one in wide, two in compact). */
  readonly filterLines: number
  /** Whether the feed shows the extra columns of the wide mode. */
  readonly feedColumns: 'full' | 'short'
  /** Rows available to the middle row (the action area and the feed). */
  readonly middleHeight: number
}

/** Chooses the layout for a terminal size. */
export function computePairLayout(width: number, height: number): PairLayout {
  const mode: LayoutMode = width < MINIMUM_WIDTH || height < MINIMUM_HEIGHT ? 'tooSmall' : width >= 120 && height >= 34 ? 'wide' : 'compact'
  const summaryHeight = 4
  const headsHeight = 4
  const keybarHeight = 1
  return {
    mode,
    width,
    height,
    summaryHeight,
    headsHeight,
    actionWidth: mode === 'wide' ? 46 : 33,
    filterLines: mode === 'wide' ? 1 : 2,
    feedColumns: mode === 'wide' ? 'full' : 'short',
    middleHeight: Math.max(0, height - summaryHeight - headsHeight - keybarHeight),
  }
}
