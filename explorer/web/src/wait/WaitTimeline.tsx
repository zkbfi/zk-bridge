import type { FeedItem, PairConfig } from "@terminal/model/types";
import { chainsFor } from "../bridge/bridge-model";
import { basisText, clockText, durationText, rangeText, remainingOf, type FeeReading, type Timeline } from "./wait-model";
import { useTimeline } from "./use-wait";
import "./wait.css";

type Direction = FeedItem["direction"];

/** Whether the proof step names the "Request a proof" button: the proof may wait for a batch. */
const mentionsRequest = (timeline: Timeline): boolean => timeline.start === "batch" || timeline.start === "testnet";

/**
 * The steps of a transfer with a typical and a worst-case wait each, and the total on top. It says what the numbers rest
 * on: the last 7 days of transfers, or the chain and the proof rule.
 *
 * @param props The timeline and the name of the source chain.
 */
export const WaitTimeline = ({ timeline, sourceName }: { readonly timeline: Timeline; readonly sourceName: string }) => {
  const worst = Math.max(1, ...timeline.steps.map((step) => step.range.worst));
  return (
    <div className="zb-wait" data-basis={timeline.basis}>
      <p className="zb-wait-head">{rangeText(timeline.total)}</p>
      <div className="zb-wait-cols" aria-hidden="true">
        <span>Typical</span>
        <span>Worst case</span>
      </div>
      <ol className="zb-wait-steps">
        {timeline.steps.map((step) => (
          <li key={step.key} className="zb-wait-step" data-step={step.key}>
            <span className="zb-wait-label">
              {step.key === "final" ? `Final on ${sourceName}` : step.label}
              <small>{step.note}</small>
            </span>
            <span className="zb-wait-typical">{durationText(step.range.typical)}</span>
            <span className="zb-wait-worst">{durationText(step.range.worst)}</span>
            <span className="zb-wait-bar" aria-hidden="true">
              <i style={{ width: `${(step.range.worst / worst) * 100}%` }} data-part="worst" />
              <i style={{ width: `${(step.range.typical / worst) * 100}%` }} data-part="typical" />
            </span>
          </li>
        ))}
      </ol>
      <p className="zb-wait-basis">
        {basisText(timeline)}
        {mentionsRequest(timeline) ? <> Request a proof starts one now.</> : null}
      </p>
    </div>
  );
};

/**
 * What is left of one transfer in flight, from its timeline: "6–18 min left", and when it usually finishes.
 *
 * @param row The transfer.
 * @param now Unix seconds now.
 */
const useRemaining = (row: FeedItem, now: number) => {
  const timeline = useTimeline(row.direction, { kind: "unknown" });
  return { timeline, left: remainingOf(timeline, row.status, now - row.sentAt) };
};

/**
 * The time left on a transfer card, with the old estimate while the timeline cannot be told.
 *
 * @param props The transfer and the time.
 */
export const TransferWaitTime = ({ row, now }: { readonly row: FeedItem; readonly now: number }) => {
  const { left } = useRemaining(row, now);
  if (left === null) return null;
  return <span className="zb-right zb-left-time">{left.late ? "past the worst case" : `${durationText(left.typical)} left`}</span>;
};

/**
 * The line under a transfer in flight: when it usually finishes and the latest it is expected, or that it is past its
 * worst case.
 *
 * @param props The transfer, the time and its pair.
 */
export const TransferWaitLine = ({ row, now, pair }: { readonly row: FeedItem; readonly now: number; readonly pair: PairConfig }) => {
  const { timeline, left } = useRemaining(row, now);
  if (left === null) return null;
  const { destination } = chainsFor(pair, row.direction);
  const total = durationText(timeline.total.worst);
  return (
    <p className="zb-wait-line" data-late={left.late ? "true" : undefined}>
      {left.late
        ? `Past the worst case of ${total} for ${destination.name}. The proof or the delivery is still waiting.`
        : `Usually done by ${clockText(now + left.typical)}, up to ${clockText(now + left.worst)}.`}
    </p>
  );
};

/**
 * One direction on Explore: the total, then its steps, from what was measured over the last 7 days.
 *
 * @param props The direction and the pair.
 */
export const DirectionWait = ({ direction, pair }: { readonly direction: Direction; readonly pair: PairConfig }) => {
  const observed: FeeReading = { kind: "observed" };
  const timeline = useTimeline(direction, observed);
  const { source, destination } = chainsFor(pair, direction);
  return (
    <section className="zb-xwait" aria-label={`Wait from ${source.name} to ${destination.name}`}>
      <h3>
        {source.name} to {destination.name}
      </h3>
      <WaitTimeline timeline={timeline} sourceName={source.name} />
    </section>
  );
};

/**
 * Explore's section on waits: both directions of the pair.
 *
 * @param props The pair.
 */
export const ExploreWaits = ({ pair }: { readonly pair: PairConfig }) => (
  <div className="zb-col">
    <h2 className="zb-m-head" style={{ padding: "14px 0 4px" }}>How long a transfer takes</h2>
    <DirectionWait direction="first-to-second" pair={pair} />
    <DirectionWait direction="second-to-first" pair={pair} />
  </div>
);
