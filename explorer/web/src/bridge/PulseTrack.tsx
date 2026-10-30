/**
 * The pulse: a transfer's progress, drawn like the mark. A solid source dot, a track, the stage stops and the
 * destination dot; the two-tone pill sits at the current position. Owner's rules: no opacity anywhere (two solid
 * colours: lit accent behind the pill, dark ember ahead), passed stops pale and stops ahead dark, proportions "B,
 * matched" (the pill twice the track's height, the stops a third of the pill's). Delivered: solid track, both dots lit.
 */

/** Props of {@link PulseTrack}. */
export type PulseTrackProps = {
  /** 0 at the source, 1 delivered. */
  readonly position: number;
  /** Where the stage stops sit, between 0 and 1. */
  readonly stops?: readonly number[];
  /** What the track says to screen readers, such as "Final, waiting for the proof". */
  readonly label: string;
};

const TRACK = 3;
const PILL_H = 6.4;
const PILL_W = 14;
const STOP_R = 1.2;
const CORE = 2.4;
const X0 = 8;
const X1 = 112;

export const PulseTrack = ({ position, stops = [1 / 3, 1 / 2, 2 / 3], label }: PulseTrackProps) => {
  const p = Math.min(1, Math.max(0, position));
  const done = p >= 1;
  const x = X0 + (X1 - X0) * p;
  const half = PILL_W / 2 - PILL_H / 2;
  return (
    <svg viewBox="0 0 120 12" width="100%" role="img" aria-label={label} style={{ display: "block" }} data-position={p}>
      <line x1={X0} y1="6" x2={X1} y2="6" stroke="var(--zb-track-ahead)" strokeWidth={TRACK} data-part="ahead" />
      <line x1={X0} y1="6" x2={done ? X1 : x} y2="6" stroke="var(--zb-accent)" strokeWidth={TRACK} data-part="lit" />
      {stops.map((stop) => (
        <circle key={stop} cx={X0 + (X1 - X0) * stop} cy="6" r={STOP_R} fill={stop <= p ? "var(--zb-stop-passed)" : "var(--zb-stop-ahead)"} data-part="stop" />
      ))}
      {done ? null : (
        <g data-part="pill">
          <line x1={x - half} y1="6" x2={x + half} y2="6" stroke="var(--zb-accent)" strokeWidth={PILL_H} strokeLinecap="round" />
          <line x1={x - half} y1="6" x2={x + half} y2="6" stroke="var(--zb-core)" strokeWidth={CORE} strokeLinecap="round" />
        </g>
      )}
      <circle cx="6" cy="6" r="4" fill="var(--zb-accent)" data-part="source" />
      <circle cx="114" cy="6" r="4" fill={done ? "var(--zb-accent)" : "var(--zb-track-ahead)"} data-part="destination" />
    </svg>
  );
};
