/**
 * The pure model of the two tip graphs: the delivery cost against the base fee, and the tip against the base fee. Both
 * graphs share the same x scale and the same y scale, so the eye can compare one line with the other. This file holds
 * all the arithmetic (scales, ticks, paths, the nearest point), so the view only draws what it returns.
 */
import { requestedPayoutOf, settingsOf, tipCoverage, type FeeDirector, type TipCoverage, type TipCoveragePoint } from "@zk-bridge/shared";
import type { DeliverySelection } from "../tx/delivery-selection";

/** The wei in one gwei and one native coin. */
const WEI_PER_GWEI = 1e9;
const WEI_PER_COIN = 1e18;

/** The number of points of each line. */
export const CHART_POINT_COUNT = 41;

/** A transfer value large enough that it never clamps the tip: the clamp is already inside the limit. */
const UNCLAMPED_VALUE = 2n ** 200n;

/** The size of the drawing, in drawing units. */
export const CHART_FRAME = { width: 520, height: 170, left: 52, right: 16, top: 12, bottom: 28 } as const;

/**
 * The director that makes the graph. A fixed or share tip is flat in the base fee, so the amount now stands for it. A gas
 * based tip keeps its terms, and its limit is the smaller of the limit and the amount in the transfer.
 *
 * @param delivery The tip that the form can send.
 */
export const graphDirectorOf = (delivery: DeliverySelection): FeeDirector => {
  if (delivery.description.mode === "gas") return { ...delivery.director, limit: delivery.maximumTip };
  return { ...delivery.director, settings: settingsOf({ mode: "fixed" }), limit: delivery.description.nowUnits, multiplier: 0n };
};

/**
 * Finds the coverage of a tip that the form can send. The priority fee follows from the cost now, which is the delivery gas
 * times the base fee plus the priority fee.
 *
 * @param delivery The tip that the form can send.
 * @param points How many points to compute.
 */
export const coverageOfDelivery = (delivery: DeliverySelection, points: number = CHART_POINT_COUNT): TipCoverage => {
  const gas = delivery.suggestions.dataSource.gas;
  const baseFeeWei = delivery.suggestions.dataSource.baseFeeWei;
  return tipCoverage({
    director: graphDirectorOf(delivery),
    deliveryGas: gas,
    priorityFeeWei: delivery.suggestions.cost.totalWei / gas - baseFeeWei,
    baseFeeNowWei: baseFeeWei,
    transferValue: UNCLAMPED_VALUE,
    price: { tokenValueInWei: delivery.token.valueInWei, tokenDecimals: delivery.token.decimals },
    points,
    payout: requestedPayoutOf(delivery.director.settings),
  });
};

/** One step of a 1, 2, 5 series that is at least `raw`. */
const niceStep = (raw: number): number => {
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const fraction = raw / magnitude;
  const factor = [1, 2, 5, 10].find((candidate) => fraction <= candidate) as number; // The fraction is at most 10.
  return factor * magnitude;
};

/** Ticks at round values from zero up to a round maximum that is not below `maximum`. */
export const niceTicks = (maximum: number, wanted: number): { readonly ticks: readonly number[]; readonly top: number } => {
  const step = niceStep(maximum / wanted);
  const count = Math.ceil(maximum / step - 1e-9);
  return { ticks: Array.from({ length: count + 1 }, (_, index) => index * step), top: count * step };
};

/** A number for a label: three significant digits, no exponent. */
export const formatNumber = (value: number): string => value.toLocaleString("en-US", { maximumSignificantDigits: 3, maximumFractionDigits: 18 });

/** A tick and where it sits. */
export type ChartTick = { readonly value: number; readonly position: number; readonly label: string };

/** Everything the view draws. */
export type ChartModel = {
  readonly points: readonly TipCoveragePoint[];
  readonly xTicks: readonly ChartTick[];
  readonly yTicks: readonly ChartTick[];
  /** The path of the cost line. */
  readonly costPath: string;
  /** The path of the tip line. The tip is cut off at the top of the shared scale. */
  readonly tipPath: string;
  /** The x position of the end of the covered stretch, or null when the tip covers nowhere or everywhere. */
  readonly crossingX: number | null;
  readonly xAt: (baseFeeWei: bigint) => number;
  readonly yAt: (wei: bigint) => number;
  /** The index of the point that is nearest to a position in drawing units. */
  readonly nearestIndex: (x: number) => number;
};

const toPath = (coordinates: readonly (readonly [number, number])[]): string => coordinates.map(([x, y], index) => `${index === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");

/**
 * Builds the shared scales and the two paths. The y scale reaches the highest cost, or up to twice that when the tip is
 * higher, so a very large tip does not flatten the cost line. A tip above the scale runs off the top, and the table shows it.
 *
 * @param coverage The result of the coverage computation.
 */
export const buildChartModel = (coverage: TipCoverage): ChartModel => {
  const { points } = coverage;
  const { width, height, left, right, top, bottom } = CHART_FRAME;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const lastPoint = points[points.length - 1] as TipCoveragePoint; // A coverage always holds two points or more.
  const maxCost = Number(lastPoint.costWei) / WEI_PER_COIN;
  const maxTip = Math.max(...points.map((point) => Number(point.tipWei))) / WEI_PER_COIN;
  const yScale = niceTicks(Math.max(maxCost, Math.min(maxTip, maxCost * 2)), 4);
  const xScale = niceTicks(Number(lastPoint.baseFeeWei) / WEI_PER_GWEI, 4);
  const xOfGwei = (gwei: number): number => left + (gwei / xScale.top) * plotWidth;
  const yOfCoin = (coin: number): number => top + plotHeight - (coin / yScale.top) * plotHeight;
  const xAt = (baseFeeWei: bigint): number => xOfGwei(Number(baseFeeWei) / WEI_PER_GWEI);
  const yAt = (wei: bigint): number => yOfCoin(Number(wei) / WEI_PER_COIN);
  const crossing = coverage.coveredUpToBaseFeeWei;
  return {
    points,
    xTicks: xScale.ticks.map((value) => ({ value, position: xOfGwei(value), label: formatNumber(value) })),
    yTicks: yScale.ticks.map((value) => ({ value, position: yOfCoin(value), label: formatNumber(value) })),
    costPath: toPath(points.map((point) => [xAt(point.baseFeeWei), yAt(point.costWei)])),
    tipPath: toPath(points.map((point) => [xAt(point.baseFeeWei), Math.max(yAt(point.tipWei), top - 4)])),
    crossingX: crossing === null || coverage.coveredEverywhere ? null : xAt(crossing),
    xAt,
    yAt,
    nearestIndex: (x) => {
      const gwei = ((x - left) / plotWidth) * xScale.top;
      const fraction = gwei / (Number(lastPoint.baseFeeWei) / WEI_PER_GWEI);
      return Math.min(points.length - 1, Math.max(0, Math.round(fraction * (points.length - 1))));
    },
  };
};
