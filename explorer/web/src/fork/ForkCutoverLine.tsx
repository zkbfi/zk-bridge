import type { ForkCutoverView } from "./use-fork";

/** Show the countdown from this long before the pause: seven days. */
export const COUNTDOWN_SHOWN_SECONDS = 7 * 86_400;

/**
 * The words under the Bridge button about the next fork of the source chain: the countdown to the pause and what happens
 * (from seven days before it), the warning that the light client head could not be read, and which saved copy of the fork
 * schedule the page used when the beacon node did not answer. A paused or blocked route says it on the button itself
 * (`forkPauseOf`), so the countdown stays out of the way then.
 *
 * @param props The view of `useForkCutover`, or null while nothing is read.
 */
export const ForkCutoverLine = ({ view }: { readonly view: ForkCutoverView | null }) => {
  if (view === null) return null;
  const { verdict, text } = view;
  const note = text.scheduleNote === null ? null : <span data-testid="fork-schedule-note">{text.scheduleNote}</span>;
  const quiet =
    verdict.kind === "paused" || verdict.kind === "blocked" || text.headline === null || (verdict.kind === "open" && (verdict.secondsToPause === null || verdict.secondsToPause > COUNTDOWN_SHOWN_SECONDS));
  if (quiet && note === null) return null;
  return (
    <p className={verdict.kind === "unknown" || note !== null ? "zb-verdict zb-warn-text" : "zb-verdict"} data-testid="fork-cutover-line" data-kind={verdict.kind}>
      {quiet || text.countdown === null ? null : <b data-testid="fork-cutover-countdown">{text.countdown}. </b>}
      {quiet ? null : text.headline}
      {quiet || note === null ? null : " "}
      {note}
    </p>
  );
};

/**
 * What the Bridge button says when the route is paused before a fork, or blocked because no fork schedule can be used: the
 * label and the line with the numbers. Null when sends are offered.
 *
 * @param view The view of `useForkCutover`, or null.
 * @param sourceName The name of the chain that sends.
 */
export const forkPauseOf = (view: ForkCutoverView | null, sourceName: string): { readonly label: string; readonly detail: string } | null => {
  if (view === null || view.text.headline === null) return null;
  if (view.verdict.kind === "blocked") return { label: `${sourceName} sends wait for the fork schedule`, detail: view.text.headline };
  if (view.verdict.kind !== "paused") return null;
  const detail = view.text.scheduleNote === null ? view.text.headline : `${view.text.headline} ${view.text.scheduleNote}`;
  return { label: `${sourceName} sends paused for the ${view.verdict.fork.name} fork`, detail };
};
