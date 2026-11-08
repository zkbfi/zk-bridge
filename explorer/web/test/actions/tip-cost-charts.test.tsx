import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { buildChartModel, formatNumber, graphDirectorOf, graphReadinessOf, niceTicks, NEEDS_DATA_MESSAGE, NEEDS_PRICE_MESSAGE, type GraphReadiness } from "../../src/actions/tip-cost-chart-model";
import { TipCostCharts } from "../../src/actions/TipCostCharts";
import { selectDelivery, type DeliveryMode, type DeliverySelection } from "../../src/tx/delivery-selection";
import { DEFAULT_MARGIN_RATE } from "../../src/tx/delivery-selection";
import { RATE_SCALE } from "@zk-bridge/shared";
import { buildDeliveryReport } from "../helpers";
import { renderPage } from "../render";

const recipient = "0x00000000000000000000000000000000000000aa" as const;
const router = "0x00000000000000000000000000000000000000bb" as const;
const WEI_PER_COIN = 10n ** 18n;

/** A token worth one coin each, with 18 decimals, so a token unit is a wei. */
const selectionOf = (mode: DeliveryMode, overrides: { gasMargin?: bigint; baseFeeCeilingWei?: bigint | null; percentageRate?: bigint; priced?: boolean; baseFeeWei?: bigint } = {}): DeliverySelection => {
  const result = selectDelivery(
    {
      mode,
      recipient,
      transferValue: 10n ** 21n,
      transferValueAtMost: 10n ** 21n,
      token: { symbol: "WPLS", decimals: 18 },
      tokenValueInWei: overrides.priced === false ? null : WEI_PER_COIN,
      senderPrice: overrides.priced === false ? null : { numerator: 10n ** 18n, denominator: WEI_PER_COIN },
      payout: "token",
      destinationName: "PulseChain",
      report: buildDeliveryReport(369, overrides.baseFeeWei === undefined ? {} : { baseFeeWei: overrides.baseFeeWei }),
      priorityFeeWei: 10n ** 9n,
      percentageRate: overrides.percentageRate ?? RATE_SCALE / 1000n,
      fixedAmount: null,
      marginRate: DEFAULT_MARGIN_RATE,
      gasMargin: overrides.gasMargin ?? RATE_SCALE,
      baseFeeCeilingWei: overrides.baseFeeCeilingWei ?? null,
      callGas: 0n,
    },
    { router, defaultRouter: router },
  );
  if (result.kind !== "available") throw new Error(result.reason);
  return result;
};

const coverageOfDelivery = (delivery: DeliverySelection) => {
  const readiness: GraphReadiness = graphReadinessOf(delivery);
  if (readiness.kind !== "ready") throw new Error(readiness.message);
  return readiness.coverage;
};

const renderCharts = (delivery: DeliverySelection) => renderPage(<TipCostCharts delivery={delivery} nativeSymbol="PLS" chainName="PulseChain" />);

const rectOf = (element: Element) => {
  element.getBoundingClientRect = () => ({ left: 0, top: 0, width: 520, height: 170, right: 520, bottom: 170, x: 0, y: 0, toJSON: () => ({}) });
};

describe("the cost and tip graphs", () => {
  it("shows two charts with the same axes, titles Delivery cost and Your tip", () => {
    renderCharts(selectionOf("gas-multiplier"));
    const cost = screen.getByTestId("chart-cost");
    const tip = screen.getByTestId("chart-tip");
    expect(within(cost).getByRole("heading", { level: 4 })).toHaveTextContent("Delivery cost");
    expect(within(tip).getByRole("heading", { level: 4 })).toHaveTextContent("Your tip");
    const tickTexts = (chart: HTMLElement) => Array.from(chart.querySelectorAll("svg text")).filter((node) => !node.textContent?.includes("tip stops")).map((node) => node.textContent);
    expect(tickTexts(cost)).toEqual(tickTexts(tip));
    expect(cost.querySelector("path")?.getAttribute("stroke-width")).toBe("2");
  });

  it("the crossing base fee is marked in both and named in the sentence", () => {
    // Gas multiplier 0.5 with the base fee ceiling at twice now: the tip is under the cost at the ceiling.
    renderCharts(selectionOf("gas-multiplier", { gasMargin: RATE_SCALE * 3n }));
    expect(screen.getByTestId("crossing-cost")).toBeInTheDocument();
    expect(screen.getByTestId("crossing-tip")).toBeInTheDocument();
    expect(screen.getByTestId("tip-cost-sentence")).toHaveTextContent(/Your tip covers the delivery cost .* PulseChain .* gwei\. .*Anyone can still deliver it\./);
  });

  it("marks no crossing when the tip covers everywhere or nowhere, and keeps the wording free of any promise", () => {
    renderCharts(selectionOf("percentage", { percentageRate: RATE_SCALE / 2n }));
    expect(screen.queryByTestId("crossing-cost")).toBeNull();
    expect(screen.getByTestId("tip-cost-sentence")).toHaveTextContent("at every base fee on PulseChain");
    expect(screen.getByTestId("tip-cost-charts").textContent).not.toMatch(/prov/i);
  });

  it("puts the label of a crossing on the right of the line when the crossing is early on the axis", () => {
    // The fixed suggestion adds ten percent to the cost now, so the tip stops covering soon after the base fee now.
    renderCharts(selectionOf("fixed"));
    const label = within(screen.getByTestId("crossing-tip")).getByText("tip stops covering");
    expect(label).toHaveAttribute("text-anchor", "start");
  });

  it("puts the label of a late crossing on the left of the line", () => {
    renderCharts(selectionOf("gas-multiplier", { gasMargin: RATE_SCALE * 3n }));
    const label = within(screen.getByTestId("crossing-tip")).getByText("tip stops covering");
    expect(label).toHaveAttribute("text-anchor", "end");
  });

  it("draws a fixed tip as a flat line", () => {
    const delivery = selectionOf("fixed");
    const model = buildChartModel(coverageOfDelivery(delivery));
    const heights = new Set(model.tipPath.split(" ").map((step) => step.split(",")[1]));
    expect(heights.size).toBe(1);
  });

  it("a table view lists every point", () => {
    renderCharts(selectionOf("gas-multiplier"));
    const table = within(screen.getByTestId("tip-cost-table")).getByRole("table", { hidden: true });
    expect(within(table).getAllByRole("row", { hidden: true })).toHaveLength(41 + 1);
  });

  it("the tooltip shows base fee, cost and tip at the pointer", () => {
    renderCharts(selectionOf("gas-multiplier"));
    const svg = within(screen.getByTestId("chart-cost")).getByRole("img");
    rectOf(svg);
    expect(screen.getByTestId("tip-cost-tooltip")).toHaveTextContent("Point at a graph");
    fireEvent.pointerMove(svg, { clientX: 260 });
    const coverage = coverageOfDelivery(selectionOf("gas-multiplier"));
    const middle = coverage.points[20]!;
    const tooltip = screen.getByTestId("tip-cost-tooltip");
    expect(tooltip).toHaveTextContent(`Base fee ${formatNumber(Number(middle.baseFeeWei) / 1e9)} gwei`);
    expect(tooltip).toHaveTextContent(`Delivery cost ${formatNumber(Number(middle.costWei) / 1e18)} PLS`);
    expect(tooltip).toHaveTextContent(`Your tip ${formatNumber(Number(middle.tipWei) / 1e18)} PLS`);
    // The crosshair appears in both charts.
    expect(within(screen.getByTestId("chart-tip")).getAllByRole("img")[0]!.querySelectorAll("circle")).toHaveLength(1);
    fireEvent.pointerLeave(svg);
    expect(screen.getByTestId("tip-cost-tooltip")).toHaveTextContent("Point at a graph");
  });

  it("reads points with the arrow keys and clears on blur", () => {
    renderCharts(selectionOf("gas-multiplier"));
    const svg = within(screen.getByTestId("chart-tip")).getByRole("img");
    fireEvent.keyDown(svg, { key: "Tab" });
    expect(screen.getByTestId("tip-cost-tooltip")).toHaveTextContent("Point at a graph");
    fireEvent.keyDown(svg, { key: "ArrowLeft" });
    expect(screen.getByTestId("tip-cost-tooltip")).toHaveTextContent("Base fee 0 gwei");
    fireEvent.keyDown(svg, { key: "ArrowRight" });
    fireEvent.keyDown(svg, { key: "ArrowRight" });
    expect(screen.getByTestId("tip-cost-tooltip")).not.toHaveTextContent("Base fee 0 gwei");
    fireEvent.blur(svg);
    expect(screen.getByTestId("tip-cost-tooltip")).toHaveTextContent("Point at a graph");
  });

  it("stops at the ends of the axis and clamps a pointer outside the plot", () => {
    renderCharts(selectionOf("gas-multiplier"));
    const svg = within(screen.getByTestId("chart-cost")).getByRole("img");
    rectOf(svg);
    fireEvent.pointerMove(svg, { clientX: 5000 });
    expect(screen.getByTestId("tip-cost-tooltip")).toHaveTextContent("Base fee 28 gwei");
    fireEvent.keyDown(svg, { key: "ArrowRight" });
    expect(screen.getByTestId("tip-cost-tooltip")).toHaveTextContent("Base fee 28 gwei");
    fireEvent.pointerMove(svg, { clientX: -5000 });
    expect(screen.getByTestId("tip-cost-tooltip")).toHaveTextContent("Base fee 0 gwei");
  });

  it("keeps a tip that is far above the cost on the scale of the cost", () => {
    const delivery = selectionOf("gas-multiplier", { gasMargin: RATE_SCALE * 1000n, baseFeeCeilingWei: 10n ** 12n });
    const model = buildChartModel(coverageOfDelivery(delivery));
    expect(model.yTicks[model.yTicks.length - 1]!.value).toBeLessThanOrEqual(Number(model.points[40]!.costWei) / 1e18 * 4);
  });
});

describe("when the graphs cannot be drawn", () => {
  it("says why and what to do when no coin price is known, in place of the graphs", () => {
    renderCharts(selectionOf("percentage", { priced: false }));
    expect(screen.getByTestId("tip-cost-blocked")).toHaveTextContent(NEEDS_PRICE_MESSAGE);
    expect(screen.queryByTestId("chart-cost")).toBeNull();
  });

  it("does not throw on a base fee of zero, and says so", () => {
    renderCharts(selectionOf("gas-multiplier", { baseFeeWei: 0n }));
    expect(screen.getByTestId("tip-cost-blocked")).toHaveTextContent(NEEDS_DATA_MESSAGE);
  });

  it("does not throw on zero delivery gas, and says so", () => {
    const delivery = selectionOf("gas-multiplier");
    const zeroGas = { ...delivery, suggestions: { ...delivery.suggestions, dataSource: { ...delivery.suggestions.dataSource, gas: 0n } } };
    renderCharts(zeroGas);
    expect(screen.getByTestId("tip-cost-blocked")).toHaveTextContent(NEEDS_DATA_MESSAGE);
  });

  it("takes the priority fee from the selection, not from the cost", () => {
    const delivery = selectionOf("gas-multiplier");
    const higher = { ...delivery, priorityFeeWei: delivery.priorityFeeWei * 3n };
    expect(coverageOfDelivery(higher).points[0]!.costWei).toBe(delivery.suggestions.dataSource.gas * higher.priorityFeeWei);
  });

  it("says that the tip goes to the reward address of the router and promises nothing", () => {
    renderCharts(selectionOf("gas-multiplier"));
    expect(screen.getByTestId("tip-cost-nature")).toHaveTextContent("reward address of the delivery router");
    expect(screen.getByTestId("tip-cost-sentence")).toHaveTextContent("A tip is voluntary and promises nothing.");
  });
});

describe("the chart model", () => {
  it("builds round ticks up to a round top", () => {
    expect(niceTicks(0.0037, 4)).toEqual({ ticks: [0, 0.001, 0.002, 0.003, 0.004], top: 0.004 });
    expect(niceTicks(40, 4).top).toBe(40);
    expect(niceTicks(9, 4).top).toBe(10);
  });

  it("turns a fixed or share tip into a flat director at the amount now", () => {
    const share = selectionOf("percentage");
    const director = graphDirectorOf(share);
    expect(director.limit).toBe(share.description.nowUnits);
    expect(director.multiplier).toBe(0n);
  });

  it("keeps the terms of a gas based tip and limits it by the transfer", () => {
    const gas = selectionOf("gas-multiplier");
    expect(graphDirectorOf(gas)).toEqual({ ...gas.director, limit: gas.maximumTip });
  });
});
