import { ExternalLink } from "./icons";

/** One step of a transfer. */
export type Step = {
  readonly label: string;
  /** When it happened (shown for reached steps). */
  readonly at?: string;
  /** How long until it happens (shown for steps ahead). */
  readonly estimate?: string;
  /** The transaction or block on the chain's explorer (linked for reached steps only). */
  readonly href?: string;
};

/**
 * The steps of a transfer: dots joined by a line, lit up to the current step and dark after it (the pulse turned on
 * its side). A reached step ends with an external-link icon, right-justified past its timestamp (owner).
 *
 * @param props The steps and the index of the current one (steps.length when delivered).
 */
export const StepList = ({ steps, current }: { readonly steps: readonly Step[]; readonly current: number }) => (
  <ol className="zb-steps">
    {steps.map((step, index) => {
      const state = index < current ? "done" : index === current ? "now" : "ahead";
      const reached = index <= current;
      return (
        <li key={step.label} className="zb-step" data-state={state}>
          <span className="zb-step-dot" aria-hidden="true" />
          <span>{step.label}</span>
          <span className="zb-step-time">{reached ? step.at : step.estimate}</span>
          {reached && step.href !== undefined ? (
            <a href={step.href} target="_blank" rel="noreferrer" aria-label={`${step.label} on the explorer`}>
              <ExternalLink />
            </a>
          ) : null}
        </li>
      );
    })}
  </ol>
);
