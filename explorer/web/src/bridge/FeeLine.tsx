import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { ClockIcon, FloppyIcon, GasCan, MoneyHand } from "./icons";
import type { TransferStep } from "./bridge-model";

/**
 * One fee value (owner, quote 90: "a slider to them with a recommended tick and a reset to receommended button but they
 * need to be able to control everything"): a slider with tick marks, an exact input right-justified against its unit, a
 * "recommended" tick with a reset shown only when the value differs, and optionally a shaded band (a range the value or
 * the fee could land in). The tip drawer and the delivery menu draw every value with this one control.
 */
export type FeeSlider = {
  readonly label: string;
  readonly help: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  /** A short reading beside the input, such as the value in dollars or the level's name. */
  readonly valueText?: ReactNode;
  readonly ticks: readonly { readonly at: number; readonly label: string }[];
  readonly onChange: (value: number) => void;
  /**
   * The exact value as text, typed against its unit: `check` names a problem (shown inline) or returns null, and
   * `onText` writes a text that passed.
   */
  readonly input?: { readonly text: string; readonly unit: ReactNode; readonly check: (text: string) => string | null; readonly onText: (text: string) => void };
  /** The value automatic mode would use: a "recommended" tick, and "Reset to recommended" while the value differs. */
  readonly recommended?: { readonly at: number; readonly differs: boolean; readonly onReset: () => void };
  /** A shaded band on the track, in the slider's units, with a mark inside it (the anchor) when given. */
  readonly band?: { readonly from: number; readonly to: number; readonly label: string; readonly mark?: number };
  /** A line under the track, such as the range in words. */
  readonly note?: ReactNode;
  /** A small save button beside the value (a floppy disk) that makes it the default; `label` names what it does. */
  readonly save?: { readonly saved: boolean; readonly onSave: () => void; readonly label: string };
  /** A line under the label row saying who sets the value (automatic or you), with a way back when there is one. */
  readonly status?: { readonly text: string; readonly action?: { readonly label: string; readonly onClick: () => void } };
};

/** A gas level: 1 Normal, 2 High, 3 Highest. */
export type FeeGasLevel = 1 | 2 | 3;

/** Props of {@link FeeLine}. */
export type FeeLineProps = {
  /** The fee (tip and delivery together, owner: "we need to couple them in the ui"), already with its token icon. */
  readonly tip: ReactNode;
  readonly tipHelp: string;
  /** What the fee covers, shown in the tip drawer (delivery gas, proof, the gas level, tip, the fee); empty without prices. */
  readonly breakdown: readonly { readonly label: string; readonly value: string; readonly total?: boolean }[];
  /** One line on the gas level chosen now: what it lets the deliverer spend and what it is expected to cost. */
  readonly gasHelp: string;
  readonly gasLevel: 0 | FeeGasLevel;
  /**
   * Called with the next gas level when the user taps the bars beside the gas can (Normal → High → Highest → Normal) or
   * presses an arrow key on them. Without it the can only shows the level.
   */
  readonly onGasLevel?: (level: FeeGasLevel) => void;
  readonly time: string;
  readonly steps: readonly TransferStep[];
  readonly sliders: readonly FeeSlider[];
  /** A line under the sliders, such as what happens left of the break-even tick. */
  readonly sliderNote: string | null;
};

type Open = "tip" | "time" | null;

/** How long the content takes to close before a swap shows the next item's (the close timing of the drawer's CSS). */
export const SWAP_MILLISECONDS = 120;

/** The name of each gas level. */
export const GAS_LEVEL_NAMES: Readonly<Record<FeeGasLevel, string>> = { 1: "Normal", 2: "High", 3: "Highest" };

/** The level a tap on the bars moves to: one up, and from Highest back to Normal. */
export const nextGasLevel = (level: 0 | FeeGasLevel): FeeGasLevel => (level === 1 ? 2 : level === 2 ? 3 : 1);

const reducedMotion = (): boolean => typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const Tip = ({ id, text }: { readonly id: string; readonly text: string }) => (
  <span role="tooltip" id={id} className="zb-tooltip">
    {text}
  </span>
);

/**
 * A question-mark help button: one size everywhere (an 18 px ring in a 24 px hit area), its tooltip on hover, focus or
 * tap, on the raised surface. The tooltip is placed against the row that holds the button (the nearest positioned
 * ancestor), so it never squeezes the label.
 *
 * @param props What the help is about (its accessible name is "About <label>") and the text.
 */
export const HelpButton = ({ label, text }: { readonly label: string; readonly text: string }) => {
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  const id = useId();
  const open = hovered || pinned;
  return (
    <>
      <button
        type="button"
        className="zb-q"
        aria-label={`About ${label}`}
        aria-describedby={open ? id : undefined}
        aria-expanded={open}
        onClick={() => setPinned(!pinned)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onBlur={() => {
          setPinned(false);
          setHovered(false);
        }}
      >
        <span aria-hidden="true">?</span>
      </button>
      {open ? <Tip id={id} text={text} /> : null}
    </>
  );
};

/**
 * The fee line: three soft icons with their values, no words (owner: "instead of the words "tip" and gas, you should
 * use icons"). Each has a tooltip. The tip and the time open a drawer between the line and the output amount: the tip's
 * holds the breakdown and sliders with tick marks, the time's lists every technical step. Clicking again, clicking away
 * or Escape closes. The bars beside the gas can are the gas level control (owner: "i want the 3 bars next to the gas
 * can to be clickable"): each tap moves to the next level, and the numbers follow, with the drawer left as it is.
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

  const hoverProps = (key: "tip" | "gas" | "time") => ({ onMouseEnter: () => setHover(key), onMouseLeave: () => setHover(null), onFocus: () => setHover(key), onBlur: () => setHover(null) });

  const item = (key: "tip" | "time", icon: ReactNode, value: ReactNode, help: string) => (
    <button type="button" className="zb-fee" aria-expanded={open === key} aria-controls={ids.drawer} aria-describedby={ids[key]} data-fee={key} onClick={(event) => pick(event, key)} {...hoverProps(key)}>
      {icon}
      {value}
      {hover === key && open === null ? <Tip id={ids[key]} text={help} /> : null}
    </button>
  );

  // The gas level: the can and its bars are one button; a tap moves up a level (Highest wraps to Normal), the arrow
  // keys step up and down without wrapping. Its tooltip stays while the pointer is on it, so the new level reads at once.
  const level = gasLevel === 0 ? 1 : gasLevel;
  const levelKeys = (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
    if (onGasLevel === undefined) return;
    const up = event.key === "ArrowUp" || event.key === "ArrowRight";
    const down = event.key === "ArrowDown" || event.key === "ArrowLeft";
    if (!up && !down) return;
    // The arrows belong to the bars here, not to the screen-to-screen arrows of the shell.
    event.preventDefault();
    event.stopPropagation();
    const next = up ? Math.min(3, level + 1) : Math.max(1, level - 1);
    if (next !== level) onGasLevel(next as FeeGasLevel);
  };
  const gasTip = hover === "gas" ? <Tip id={ids.gas} text={gasHelp} /> : null;
  const gas =
    onGasLevel === undefined ? (
      <span className="zb-fee zb-gas" tabIndex={0} aria-describedby={ids.gas} data-fee="gas" {...hoverProps("gas")}>
        <GasCan title="Gas" level={gasLevel} />
        {gasTip}
      </span>
    ) : (
      <button type="button" className="zb-fee zb-gas" aria-label={`Gas level: ${GAS_LEVEL_NAMES[level]}. Change`} aria-describedby={ids.gas} data-fee="gas" data-level={gasLevel} onClick={() => onGasLevel(nextGasLevel(gasLevel))} onKeyDown={levelKeys} {...hoverProps("gas")}>
        <GasCan title="Gas" level={gasLevel} />
        {gasTip}
      </button>
    );

  return (
    <div ref={root}>
      <div className="zb-fees">
        {item("tip", <MoneyHand title="Tip" />, tip, tipHelp)}
        {gas}
        {item("time", <ClockIcon title="Time" />, time, "How long until it arrives. Tap for every step.")}
      </div>
      <div className={expanded ? "zb-drawer zb-open" : "zb-drawer"} id={ids.drawer} aria-hidden={!expanded} inert={!expanded}>
        <div className="zb-drawer-inner">
          <div className="zb-drawer-body" data-shown={shown ?? undefined} style={{ "--zb-from": `${from}px` } as CSSProperties}>
            {shown === null ? null : shown === "time" ? (
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
                      <li key={line.label} data-total={line.total === true ? "" : undefined}>
                        <span>{line.label}</span>
                        <span>{line.value}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {sliders.map((slider) => (
                  <FeeControl key={slider.label} slider={slider} />
                ))}
                {sliderNote === null ? null : <p className="zb-slider-note">{sliderNote}</p>}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

const ExactInput = ({ label, input }: { readonly label: string; readonly input: NonNullable<FeeSlider["input"]> }) => {
  // While the user types, the field shows their text; a text that passes is written at once, so the slider and every
  // number follow. Leaving the field shows the value in force again.
  const [draft, setDraft] = useState<string | null>(null);
  const problem = draft === null ? null : input.check(draft);
  const text = draft ?? input.text;
  return (
    <>
      <span className="zb-exact" data-problem={problem === null ? undefined : "true"}>
        <input
          aria-label={`${label}, exact`}
          aria-invalid={problem === null ? undefined : true}
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          size={Math.max(2, Math.min(14, text.length))}
          value={text}
          onChange={(event) => {
            setDraft(event.target.value);
            if (input.check(event.target.value) === null) input.onText(event.target.value.trim());
          }}
          onBlur={() => setDraft(null)}
        />
        <span className="zb-exact-unit">{input.unit}</span>
      </span>
      {problem === null ? null : (
        <span className="zb-exact-err" role="alert">
          {problem}
        </span>
      )}
    </>
  );
};

/**
 * One fee value: the label and its ?, the reading, the exact input against its unit and the save button on one row;
 * who sets it and the reset under it; the track with its ticks, the band and the knob.
 *
 * @param props The value.
 */
export const FeeControl = ({ slider }: { readonly slider: FeeSlider }) => {
  const share = (value: number): number => (slider.max === slider.min ? 0 : Math.min(100, Math.max(0, ((value - slider.min) / (slider.max - slider.min)) * 100)));
  const ticks = [...slider.ticks, ...(slider.recommended === undefined ? [] : [{ at: slider.recommended.at, label: "recommended" }])];
  const labelRows = tickRows(ticks.map((tick) => ({ label: tick.label, left: share(tick.at) })));
  const reset = slider.recommended !== undefined && slider.recommended.differs ? slider.recommended : null;
  const action = reset === null ? (slider.status?.action ?? null) : { label: "Reset to recommended", onClick: reset.onReset };
  const errors = slider.input === undefined ? null : <ExactInput label={slider.label} input={slider.input} />;
  return (
    <div className="zb-slider">
      <div className="zb-slider-top">
        <span className="zb-label">
          {slider.label}
          <HelpButton label={slider.label} text={slider.help} />
        </span>
        <span className="zb-slider-value">
          {slider.valueText === undefined ? null : slider.input === undefined ? <b>{slider.valueText}</b> : <span className="zb-slider-read">{slider.valueText}</span>}
          {errors}
          {slider.save === undefined ? null : (
            <button type="button" className="zb-save" aria-label={slider.save.label} title={slider.save.label} disabled={slider.save.saved} onClick={slider.save.onSave}>
              <FloppyIcon />
            </button>
          )}
        </span>
      </div>
      {slider.status === undefined && action === null ? null : (
        <div className="zb-slider-mode" aria-live="polite">
          {slider.status === undefined ? null : <span>{slider.status.text}</span>}
          {action === null ? null : (
            <button type="button" className="zb-link" onClick={action.onClick}>
              {action.label}
            </button>
          )}
        </div>
      )}
      <div className="zb-range">
        <span className="zb-range-bar" />
        {slider.band === undefined ? null : (
          <span className="zb-range-band" title={slider.band.label} aria-label={slider.band.label} role="img" style={{ left: `${share(Math.min(slider.band.from, slider.band.to))}%`, width: `${Math.max(1, share(Math.max(slider.band.from, slider.band.to)) - share(Math.min(slider.band.from, slider.band.to)))}%` }} />
        )}
        {slider.band?.mark === undefined ? null : <span className="zb-range-anchor" style={{ left: `${share(slider.band.mark)}%` }} />}
        <span className="zb-range-fill" style={{ width: `${share(slider.value)}%` }} />
        {ticks.map((tick) => (
          <span key={tick.label} className="zb-range-tick" data-recommended={tick.label === "recommended" ? "" : undefined} style={{ left: `${share(tick.at)}%` }} />
        ))}
        <span className="zb-range-knob" style={{ left: `${share(slider.value)}%` }} />
        <input type="range" aria-label={slider.label} min={slider.min} max={slider.max} step={slider.step} value={slider.value} onChange={(event) => slider.onChange(Number(event.target.value))} />
      </div>
      <div className="zb-ticks" style={{ height: `${1.3 * (Math.max(0, ...labelRows.map((tick) => tick.row)) + 1) + 0.4}em` }}>
        {labelRows.map((tick) => (
          // Shifted by its own position, so a label at either end stays inside the track (centred in the middle).
          <span key={tick.label} style={{ left: `${tick.left}%`, top: `${1.3 * tick.row}em`, transform: `translateX(-${tick.left}%)` }}>
            {tick.label}
          </span>
        ))}
      </div>
      {slider.note === undefined ? null : <p className="zb-slider-band-note">{slider.note}</p>}
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
