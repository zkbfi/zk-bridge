/**
 * A joined step list whose steps open a drawer (owner: "you should still maintain the connection between completed
 * steps when the drawer is opened"). The drawer is part of the step's own list item, so the step's line spans the item's
 * full height, drawer included: it runs on, lit between completed steps and dark ahead, and grows with the drawer's
 * height (the same grid-row motion as the fee drawers).
 */
import { useEffect, useId, useState, type ReactNode } from "react";
import { Chevron, ExternalLink } from "../bridge/icons";

/** One step. A step with a drawer opens it; one with only an href links on. */
export type TrailStep = {
  readonly label: string;
  readonly done: boolean;
  /** The time, or a word for a step not reached ("waiting"). */
  readonly when: string;
  readonly href?: string;
  readonly external?: boolean;
  readonly drawer?: ReactNode;
  /** "error" draws the drawer's top line in red (a reverted call); "warning" in amber (a delivery that did not pay the recipient as asked). */
  readonly tone?: "error" | "warning";
};

/** The step list. `initiallyOpen` opens one step's drawer at first (the step where a message stopped). */
export const StepTrail = ({ steps, initiallyOpen = null }: { readonly steps: readonly TrailStep[]; readonly initiallyOpen?: number | null }) => {
  const [open, setOpen] = useState<number | null>(initiallyOpen);
  const id = useId();
  // A step that is known only after the page loaded (a pending route step) opens its drawer once, unless the reader opened another.
  useEffect(() => {
    if (initiallyOpen !== null) setOpen((before) => before ?? initiallyOpen);
  }, [initiallyOpen]);
  const current = steps.findIndex((step) => !step.done);
  return (
    <ol className="zb-steps zb-trail">
      {steps.map((step, index) => {
        const state = step.done ? "done" : index === current ? "now" : "ahead";
        const expanded = open === index;
        const row = (
          <>
            <span className="zb-step-dot" aria-hidden="true" />
            <span className="zb-trail-label">{step.label}</span>
            <span className="zb-step-time">{step.when}</span>
            {step.drawer !== undefined ? <Chevron dir={expanded ? "down" : "right"} /> : step.external === true ? <ExternalLink /> : step.href !== undefined ? <Chevron dir="right" /> : <span className="zb-trail-gap" />}
          </>
        );
        return (
          <li key={step.label} className="zb-step zb-trail-step" data-state={state} data-open={expanded}>
            {step.drawer !== undefined ? (
              <button type="button" className="zb-trail-row" aria-expanded={expanded} aria-controls={`${id}-${index}`} onClick={() => setOpen(expanded ? null : index)}>
                {row}
              </button>
            ) : step.href !== undefined ? (
              <a className="zb-trail-row" href={step.href} {...(step.external === true ? { target: "_blank", rel: "noreferrer" } : {})}>
                {row}
              </a>
            ) : (
              <span className="zb-trail-row">{row}</span>
            )}
            {step.drawer === undefined ? null : (
              <div className={expanded ? "zb-drawer zb-open" : "zb-drawer"} id={`${id}-${index}`} aria-hidden={!expanded} inert={!expanded}>
                <div className="zb-drawer-inner">
                  <div className="zb-drawer-body zb-trail-drawer" data-tone={step.tone}>{step.drawer}</div>
                </div>
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
};

/** The key/value grid inside a step's drawer. */
export const DrawerGrid = ({ rows }: { readonly rows: readonly (readonly [string, ReactNode])[] }) => (
  <dl className="zb-trail-grid">
    {rows.map(([key, value]) => (
      <div key={key}>
        <dt>{key}</dt>
        <dd>{value}</dd>
      </div>
    ))}
  </dl>
);
