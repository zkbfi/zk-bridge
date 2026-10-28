import { Box, Table, Text, chakra } from "@chakra-ui/react";
import { useMemo, useState, type KeyboardEvent, type PointerEvent } from "react";
import { TIP_NATURE, coverageSentence, type TipCoverage } from "@zk-bridge/shared";
import type { DeliverySelection } from "../tx/delivery-selection";
import { CHART_FRAME, buildChartModel, graphReadinessOf, formatNumber, type ChartModel } from "./tip-cost-chart-model";

/** The colors of the graphs. Both sets were checked with the palette validator against their own surface. */
const PALETTE_CSS = {
  "--viz-surface": "#fcfcfb",
  "--viz-ink": "#0b0b0b",
  "--viz-ink-secondary": "#52514e",
  "--viz-grid": "#e4e3df",
  "--viz-cost": "#2a78d6",
  "--viz-tip": "#eb6834",
  _dark: {
    "--viz-surface": "#1a1a19",
    "--viz-ink": "#f0efec",
    "--viz-ink-secondary": "#c3c2b7",
    "--viz-grid": "#34332f",
    "--viz-cost": "#3987e5",
    "--viz-tip": "#d95926",
  },
} as const;

const WEI_PER_GWEI = 1e9;
const WEI_PER_COIN = 1e18;

type SeriesName = "cost" | "tip";

const SERIES: Readonly<Record<SeriesName, { readonly title: string; readonly color: string }>> = {
  cost: { title: "Delivery cost", color: "var(--viz-cost)" },
  tip: { title: "Your tip", color: "var(--viz-tip)" },
};

type Point = ChartModel["points"][number];

type ChartProps = {
  readonly series: SeriesName;
  readonly model: ChartModel;
  readonly nativeSymbol: string;
  readonly activePoint: Point | null;
  readonly onActiveIndex: (index: number | null) => void;
  readonly activeIndex: number | null;
};

const gweiText = (wei: bigint): string => formatNumber(Number(wei) / WEI_PER_GWEI);
const coinNumber = (wei: bigint): string => formatNumber(Number(wei) / WEI_PER_COIN);

/** The wei that a point holds for one series. */
const valueOfSeries = (series: SeriesName, point: Point): bigint => (series === "cost" ? point.costWei : point.tipWei);

/** The step that a key moves along the points. Zero for a key that does nothing. */
const stepOfKey = (key: string): number => {
  if (key === "ArrowRight") return 1;
  if (key === "ArrowLeft") return -1;
  return 0;
};

/** One line graph. The scales come from the model, so the two graphs match. */
const Chart = ({ series, model, nativeSymbol, activePoint, activeIndex, onActiveIndex }: ChartProps) => {
  const { width, height, left, right, top, bottom } = CHART_FRAME;
  const { title, color } = SERIES[series];
  const path = series === "cost" ? model.costPath : model.tipPath;
  const move = (event: PointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    onActiveIndex(model.nearestIndex(((event.clientX - box.left) / box.width) * width));
  };
  const press = (event: KeyboardEvent<SVGSVGElement>) => {
    const step = stepOfKey(event.key);
    if (step === 0) return;
    event.preventDefault();
    onActiveIndex(Math.min(model.points.length - 1, Math.max(0, (activeIndex ?? 0) + step)));
  };
  const markerValue = activePoint === null ? 0n : valueOfSeries(series, activePoint);
  return (
    <Box data-testid={`chart-${series}`}>
      <Text fontSize="sm" fontWeight="medium" color="var(--viz-ink)" as="h4">
        {title}{" "}
        <Text as="span" fontWeight="normal" color="var(--viz-ink-secondary)">
          ({nativeSymbol}, by base fee in gwei)
        </Text>
      </Text>
      <chakra.svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`${title} against the base fee. Use the left and right arrow keys to read each point.`}
        tabIndex={0}
        width="100%"
        style={{ touchAction: "none", display: "block" }}
        onPointerMove={move}
        onPointerLeave={() => onActiveIndex(null)}
        onKeyDown={press}
        onBlur={() => onActiveIndex(null)}
      >
        {model.yTicks.map((tick) => (
          <g key={`y${tick.value}`}>
            <line x1={left} x2={width - right} y1={tick.position} y2={tick.position} stroke="var(--viz-grid)" strokeWidth="1" />
            <text x={left - 6} y={tick.position + 4} textAnchor="end" fontSize="11" fill="var(--viz-ink-secondary)">
              {tick.label}
            </text>
          </g>
        ))}
        {model.xTicks.map((tick) => (
          <text key={`x${tick.value}`} x={tick.position} y={height - bottom + 16} textAnchor="middle" fontSize="11" fill="var(--viz-ink-secondary)">
            {tick.label}
          </text>
        ))}
        <clipPath id={`clip-${series}`}>
          <rect x={left} y={top - 4} width={width - left - right} height={height - top - bottom + 4} />
        </clipPath>
        <path d={path} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" clipPath={`url(#clip-${series})`} />
        {model.crossingX === null ? null : (
          <g data-testid={`crossing-${series}`}>
            <line x1={model.crossingX} x2={model.crossingX} y1={top} y2={height - bottom} stroke="var(--viz-ink-secondary)" strokeWidth="1" strokeDasharray="4 3" />
            <text x={model.crossingX + (model.crossingX > width / 2 ? -6 : 6)} y={height - bottom - 6} textAnchor={model.crossingX > width / 2 ? "end" : "start"} fontSize="10" fill="var(--viz-ink)">
              tip stops covering
            </text>
          </g>
        )}
        {activePoint === null ? null : (
          <g pointerEvents="none">
            <line x1={model.xAt(activePoint.baseFeeWei)} x2={model.xAt(activePoint.baseFeeWei)} y1={top} y2={height - bottom} stroke="var(--viz-ink-secondary)" strokeWidth="1" />
            <circle cx={model.xAt(activePoint.baseFeeWei)} cy={Math.max(model.yAt(markerValue), top)} r="4" fill={color} stroke="var(--viz-surface)" strokeWidth="2" />
          </g>
        )}
      </chakra.svg>
    </Box>
  );
};

type TableViewProps = { readonly model: ChartModel; readonly nativeSymbol: string };

/** Every point of both lines as text, for a reader who cannot use the graphs. */
const TableView = ({ model, nativeSymbol }: TableViewProps) => (
  <chakra.details marginTop="2" data-testid="tip-cost-table">
    <chakra.summary fontSize="sm" cursor="pointer">
      Show the graphs as a table
    </chakra.summary>
    <Box maxHeight="16rem" overflowY="auto">
      <Table.Root size="sm" aria-label="Delivery cost and tip by base fee">
        <Table.Header>
          <Table.Row>
            <Table.ColumnHeader scope="col">Base fee (gwei)</Table.ColumnHeader>
            <Table.ColumnHeader scope="col" textAlign="end">
              Delivery cost ({nativeSymbol})
            </Table.ColumnHeader>
            <Table.ColumnHeader scope="col" textAlign="end">
              Your tip ({nativeSymbol})
            </Table.ColumnHeader>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {model.points.map((point) => (
            <Table.Row key={point.baseFeeWei.toString()}>
              <Table.Cell>{gweiText(point.baseFeeWei)}</Table.Cell>
              <Table.Cell textAlign="end">{coinNumber(point.costWei)}</Table.Cell>
              <Table.Cell textAlign="end">{coinNumber(point.tipWei)}</Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table.Root>
    </Box>
  </chakra.details>
);

/** Props of {@link TipCostCharts}. */
export type TipCostChartsProps = {
  /** The tip that the form can send. */
  readonly delivery: DeliverySelection;
  readonly nativeSymbol: string;
  readonly chainName: string;
};

/**
 * Two line graphs before the user sends: the delivery cost against the base fee, and the user's tip against the base fee.
 * They share the same scales. A dashed line marks the base fee above which the tip stops covering the cost, and a sentence
 * says it in plain words. A tip below the cost is allowed, and the words say that anyone can still deliver. A table holds
 * every point. Hover or the arrow keys read a point.
 *
 * @param props The tip, the native coin and the chain.
 */
const ReadyCharts = ({ coverage, nativeSymbol, chainName }: ReadyProps) => {
  const model = useMemo(() => buildChartModel(coverage), [coverage]);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const activePoint = activeIndex === null ? null : (model.points[activeIndex] as Point); // The index comes from the model.
  const shared = { model, nativeSymbol, activePoint, activeIndex, onActiveIndex: setActiveIndex };
  return (
    <Box marginTop="3" padding="3" borderRadius="md" css={PALETTE_CSS} backgroundColor="var(--viz-surface)" color="var(--viz-ink)" data-testid="tip-cost-charts">
      <Text fontSize="sm" fontWeight="medium" as="h3">
        Delivery cost and your tip, by base fee
      </Text>
      <Text fontSize="sm" color="var(--viz-ink-secondary)" data-testid="tip-cost-sentence">
        {coverageSentence(coverage, chainName)}
      </Text>
      <Text fontSize="xs" color="var(--viz-ink-secondary)" data-testid="tip-cost-nature">
        {TIP_NATURE}
      </Text>
      <Chart series="cost" {...shared} />
      <Chart series="tip" {...shared} />
      <Text fontSize="xs" color="var(--viz-ink-secondary)">
        Both graphs use the same base fee axis and the same scale. A tip above the scale runs off the top of its graph.
      </Text>
      <Box minHeight="3.5rem" aria-live="polite" data-testid="tip-cost-tooltip">
        {activePoint === null ? (
          <Text fontSize="xs" color="var(--viz-ink-secondary)">
            Point at a graph to read the base fee, the cost and the tip.
          </Text>
        ) : (
          <Text fontSize="sm">
            Base fee {gweiText(activePoint.baseFeeWei)} gwei. Delivery cost {coinNumber(activePoint.costWei)} {nativeSymbol}. Your tip {coinNumber(activePoint.tipWei)} {nativeSymbol}.
          </Text>
        )}
      </Box>
      <TableView model={model} nativeSymbol={nativeSymbol} />
    </Box>
  );
};

type ReadyProps = { readonly coverage: TipCoverage; readonly nativeSymbol: string; readonly chainName: string };

/**
 * Shows the graphs, or a short message in their place when they cannot be drawn, so the form never goes blank.
 *
 * @param props The tip, the native coin and the chain.
 */
export const TipCostCharts = ({ delivery, nativeSymbol, chainName }: TipCostChartsProps) => {
  const readiness = useMemo(() => graphReadinessOf(delivery), [delivery]);
  if (readiness.kind === "blocked") {
    return (
      <Text fontSize="sm" color="fg.muted" marginTop="3" data-testid="tip-cost-blocked">
        {readiness.message}
      </Text>
    );
  }
  return <ReadyCharts coverage={readiness.coverage} nativeSymbol={nativeSymbol} chainName={chainName} />;
};
