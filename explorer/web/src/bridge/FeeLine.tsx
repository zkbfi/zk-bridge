import { useEffect, useId, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { ClockIcon, FloppyIcon, GasCan, MoneyHand } from "./icons";
import type { TransferStep } from "./bridge-model";

/** A slider of the tip drawer: a value, its range, and tick marks with labels. */
export type FeeSlider = {
  readonly label: string;
  readonly help: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly valueText: ReactNode;
  readonly ticks: readonly { readonly at: number; readonly label: string }[];
  readonly onChange: (value: number) => void;
  /** A small save button beside the value (a floppy disk) that makes it the default; `label` names what it does. */
  readonly save?: { readonly saved: boolean; readonly onSave: () => void; readonly label: string };
};

/** Props of {@link FeeLine}. */
export type FeeLineProps = {
  /** The fee (tip and delivery together, owner: "we need to couple them in the ui"), already with its token icon. */
  readonly tip: ReactNode;
  readonly tipHelp: string;
  /** What the fee covers, shown in the tip drawer (delivery gas, proof, tip); empty without prices. */
  readonly breakdown: readonly { readonly label: string; readonly value: string }[];
  /** The gas can's help: what each gas level means. The can is a level control, not a second cost. */
  readonly gasHelp: string;
  readonly gasLevel: 0 | 1 | 2 | 3;
  /** Called with a higher (or lower) gas level the user picks on the gas can. */
  readonly onGasLevel?: (level: 1 | 2 | 3) => void;
  readonly time: string;
  readonly steps: readonly TransferStep[];
  readonly sliders: readonly FeeSlider[];
  /** A line under the sliders, such as what happens left of the break-even tick. */
  readonly sliderNote: string | null;
};

type Open = "tip" | "time" | "gas" | null;

/** How long the content takes to close before a swap shows the next item's (the close timing of the drawer's CSS). */
export const SWAP_MILLISECONDS = 120;

const reducedMotion = (): boolean => typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const Tip = ({ id, text }: { readonly id: string; readonly text: string }) => (
  <span role="tooltip" id={id} className="zb-tooltip">
    {text}
  </span>
);

/**
 * The fee line: three soft icons with their values, no words (owner: "instead of the words "tip" and gas, you should
 * use icons"). Each has a tooltip. The tip and the time open a drawer between the line and the output amount: the tip's
 * holds sliders with tick marks, the time's lists every technical step. Clicking again, clicking away or Escape closes.
 *
 * @param props The values, the help texts, the steps and the sliders.
 */
export const FeeLine = ({ tip, tipHelp, breakdown, gasHelp, gasLevel, onGasLevel, time, steps, sliders, sliderNote }: FeeLineProps) => {
  // `open` is the item the user chose (aria-expanded); `shown` is the content in the drawer, which lags a swap by the
  // close time; `expanded` drives the drawer's height (grid rows 0fr → 1fr) and the deck line.
  const [open, setOpen] = useState<Open>(null);
  const [shown, setShown] = useState<Open>(null);
  const [expanded, setExpanded] = useState(false);
  const [from, setFrom] = useState(0);
  const swap = useRef<number | undefined>(undefined);
  const [hover, setHover] = useState<"tip" | "gas" | "time" | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const ids = { tip: useId(), gas: useId(), time: useId(), drawer: useId() };

  const choose = (next: Open): void => {
    setOpen(next);
    window.clearTimeout(swap.current);
    if (next === null) {
      setExpanded(false);
      return;
    }
    if (expanded && shown !== null && shown !== next && !reducedMotion()) {
      // A swap: close the content, switch, reopen; the deck redraws from the new icon.
      setExpanded(false);
      swap.current = window.setTimeout(() => {
        setShown(next);
        setExpanded(true);
      }, SWAP_MILLISECONDS);
      return;
    }
    setShown(next);
    setExpanded(true);
  };
  useEffect(() => () => window.clearTimeout(swap.current), []);

  useEffect(() => {
    if (open === null) return;
    const away = (event: MouseEvent): void => {
      if (root.current !== null && !root.current.contains(event.target as Node)) choose(null);
    };
    const escape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") choose(null);
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", escape);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const pick = (event: ReactMouseEvent<HTMLButtonElement>, key: Open): void => {
    const box = event.currentTarget.getBoundingClientRect();
    const left = root.current?.getBoundingClientRect().left ?? 0;
    if (key !== open) setFrom(box.left + box.width / 2 - left);
    choose(open === key ? null : key);
  };

  const item = (key: "tip" | "gas" | "time", icon: ReactNode, value: ReactNode, help: string, opens: Open) => {
    const hoverProps = { onMouseEnter: () => setHover(key), onMouseLeave: () => setHover(null), onFocus: () => setHover(key), onBlur: () => setHover(null) };
    const content = (
      <>
        {icon}
        {value}
        {hover === key && open === null ? <Tip id={ids[key]} text={help} /> : null}
      </>
    );
    if (opens === null) {
      return (
        <span className="zb-fee" tabIndex={0} aria-describedby={ids[key]} data-fee={key} {...hoverProps}>
          {content}
        </span>
      );
    }
    return (
      <button type="button" className="zb-fee" aria-expanded={open === opens} aria-controls={ids.drawer} aria-describedby={ids[key]} data-fee={key} onClick={(event) => pick(event, opens)} {...hoverProps}>
        {content}
      </button>
    );
  };

  return (
    <div ref={root}>
      <div className="zb-fees">
        {item("tip", <MoneyHand title="Tip" />, tip, tipHelp, "tip")}
        {item("gas", <GasCan title="Gas" level={gasLevel} />, null, gasHelp, onGasLevel === undefined ? null : "gas")}
        {item("time", <ClockIcon title="Time" />, time, "How long until it arrives. Tap for every step.", "time")}
      </div>
      <div className={expanded ? "zb-drawer zb-open" : "zb-drawer"} id={ids.drawer} aria-hidden={!expanded} inert={!expanded}>
        <div className="zb-drawer-inner">
        <div className="zb-drawer-body" data-shown={shown ?? undefined} style={{ "--zb-from": `${from}px` } as CSSProperties}>
          {shown === null ? null : shown === "gas" && onGasLevel !== undefined ? (
            <div className="zb-menu-row">
              <span>Gas level</span>
              <span className="zb-seg" role="radiogroup" aria-label="Gas level">
                {([1, 2, 3] as const).map((level) => (
                  <button key={level} type="button" role="radio" aria-checked={gasLevel === level} onClick={() => onGasLevel(level)}>
                    <GasCan level={level} />
                    {level === 1 ? "Normal" : level === 2 ? "High" : "Highest"}
                  </button>
                ))}
              </span>
            </div>
          ) : shown === "time" ? (
            <ol className="zb-steps">
              {steps.map((step) => (
                <li key={step.label} className="zb-step" data-state="ahead">
                  <span className="zb-step-dot" aria-hidden="true" />
                  <span>{step.label}</span>
                  <span className="zb-step-time">{step.estimate}</span>
                </li>
              ))}
            </ol>
          ) : (
            <>
              {breakdown.length === 0 ? null : (
                <ul className="zb-breakdown" aria-label="What the fee covers">
                  {breakdown.map((line) => (
                    <li key={line.label}>
                      <span>{line.label}</span>
                      <span>{line.value}</span>
                    </li>
                  ))}
                </ul>
              )}
              {sliders.map((slider) => (
                <Slider key={slider.label} slider={slider} />
              ))}
              {sliderNote === null ? null : <p style={{ margin: "10px 0 0", fontSize: "var(--zb-step--1)", color: "var(--zb-muted)" }}>{sliderNote}</p>}
            </>
          )}
        </div>
        </div>
      </div>
    </div>
  );
};

const Slider = ({ slider }: { readonly slider: FeeSlider }) => {
  const [help, setHelp] = useState(false);
  const helpId = useId();
  const share = (value: number): number => ((value - slider.min) / (slider.max - slider.min)) * 100;
  const labelRows = tickRows(slider.ticks.map((tick) => ({ label: tick.label, left: share(tick.at) })));
  return (
    <div className="zb-slider">
      <div className="zb-slider-top">
        <span>
          {slider.label}
          <button type="button" className="zb-q" aria-label={`About ${slider.label}`} aria-describedby={helpId} onClick={() => setHelp(!help)} onBlur={() => setHelp(false)}>
            ?{help ? <Tip id={helpId} text={slider.help} /> : null}
          </button>
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <b>{slider.valueText}</b>
          {slider.save === undefined ? null : (
            <button type="button" className="zb-q zb-save" aria-label={slider.save.label} title={slider.save.label} disabled={slider.save.saved} onClick={slider.save.onSave}>
              <FloppyIcon />
            </button>
          )}
        </span>
      </div>
      <div className="zb-range">
        <span className="zb-range-bar" />
        <span className="zb-range-fill" style={{ width: `${share(slider.value)}%` }} />
        {slider.ticks.map((tick) => (
          <span key={tick.label} className="zb-range-tick" style={{ left: `${share(tick.at)}%` }} />
        ))}
        <span className="zb-range-knob" style={{ left: `${share(slider.value)}%` }} />
        <input type="range" aria-label={slider.label} min={slider.min} max={slider.max} step={slider.step} value={slider.value} onChange={(event) => slider.onChange(Number(event.target.value))} />
      </div>
      <div className="zb-ticks" style={{ height: `${1.3 * (Math.max(0, ...labelRows.map((tick) => tick.row)) + 1) + 0.4}em` }}>
        {labelRows.map((tick) => (
          <span key={tick.label} style={{ left: `${tick.left}%`, top: `${1.3 * tick.row}em` }}>
            {tick.label}
          </span>
        ))}
      </div>
    </div>
  );
};

/** Labels closer than this share of the track would overlap, so the later one drops to the next row. */
const TICK_LABEL_GAP = 28;

/**
 * Places slider tick labels in rows so close ones never draw over each other: each label takes the first row whose last
 * label is at least {@link TICK_LABEL_GAP} percent to its left.
 *
 * @param ticks The labels with their position along the track, in percent.
 */
export const tickRows = (ticks: readonly { readonly label: string; readonly left: number }[]): { readonly label: string; readonly left: number; readonly row: number }[] => {
  const lastInRow: number[] = [];
  return [...ticks]
    .sort((a, b) => a.left - b.left)
    .map((tick) => {
      const free = lastInRow.findIndex((left) => tick.left - left >= TICK_LABEL_GAP);
      const row = free === -1 ? lastInRow.length : free;
      lastInRow[row] = tick.left;
      return { ...tick, row };
    });
};
