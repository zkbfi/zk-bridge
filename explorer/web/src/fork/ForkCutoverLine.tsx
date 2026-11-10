import type { ForkCutoverView } from "./use-fork";

/** Show the countdown from this long before the pause: seven days. */
export const COUNTDOWN_SHOWN_SECONDS = 7 * 86_400;

/**
 * The words under the Bridge button about the next fork of the source chain: the countdown to the pause and what happens
 * (from seven days before it), or the warning that the beacon node or the light client head could not be read. A paused
 * route says it on the button itself (`forkPauseOf`), so this line stays out of the way then.
 *
 * @param props The view of `useForkCutover`, or null while nothing is read.
 */
export const ForkCutoverLine = ({ view }: { readonly view: ForkCutoverView | null }) => {
  if (view === null) return null;
  const { verdict, text } = view;
  if (verdict.kind === "paused" || text.headline === null) return null;
  if (verdict.kind === "open" && (verdict.secondsToPause === null || verdict.secondsToPause > COUNTDOWN_SHOWN_SECONDS)) return null;
  return (
    <p className={verdict.kind === "unknown" ? "zb-verdict zb-warn-text" : "zb-verdict"} data-testid="fork-cutover-line" data-kind={verdict.kind}>
      {text.countdown === null ? null : <b data-testid="fork-cutover-countdown">{text.countdown}. </b>}
      {text.headline}
    </p>
  );
};

/**
 * What the Bridge button says when the route is paused before a fork: the label and the line with the numbers. Null when the
 * route is not paused.
 *
 * @param view The view of `useForkCutover`, or null.
 * @param sourceName The name of the chain that sends.
 */
export const forkPauseOf = (view: ForkCutoverView | null, sourceName: string): { readonly label: string; readonly detail: string } | null => {
  if (view === null || view.verdict.kind !== "paused" || view.text.headline === null) return null;
  return { label: `${sourceName} sends paused for the ${view.verdict.fork.name} fork`, detail: view.text.headline };
};
