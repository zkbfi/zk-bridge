import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { Chevron, ClockIcon, FloppyIcon, GasCan, TakeMyMoney } from "./icons";
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
  readonly status?: { readonly text: string; readonly action?: { readonly label: ReactNode; readonly onClick: () => void } };
};

/** A gas level: 1 Normal, 2 High, 3 Highest. */
export type FeeGasLevel = 1 | 2 | 3;

/** Props of {@link FeeLine}. */
export type FeeLineProps = {
  /** The arrangement in a few words for the first segment ("A bot delivers it · 0.39%"), short enough for a phone. */
  readonly summary: string;
  /** The whole arrangement and the fee, for the first segment's label and tooltip. */
  readonly summaryFull: string;
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
  /**
   * The one delivery menu (owner, quote 98): who delivers and that mode's value, the gas level, both caps, the
   * breakdown and the Advanced fold. Shown in the drawer when the first segment is open.
   */
  readonly menu: ReactNode;
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
 * The delivery control (owner, quote 98: "a menu with button groups ... the low resolution gas button next to the menu
 * and then the timing button next to that, all in the same menu button"): one joined pill of three segments. The first,
 * the money hand and a tight summary of who delivers and for what, opens the one delivery menu; the gas can's bars
 * step through the gas levels in place (owner, quote 81), and every number follows; the clock opens the list of
 * technical steps. Menu and steps open in the drawer under the pill with the approved motion; clicking the segment
 * again, clicking away or Escape closes it.
 *
 * @param props The summary, the gas level, the time and steps, and the menu.
 */
export const FeeLine = ({ summary, summaryFull, gasHelp, gasLevel, onGasLevel, time, steps, menu }: FeeLineProps) => {
  // `open` is the segment the user chose (aria-expanded); `shown` is the content in the drawer, which lags a swap by the
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
      // A swap: close the content, switch, reopen; the deck redraws from the new segment.
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

  // The gas level: the can and its bars are one segment; a tap moves up a level (Highest wraps to Normal), the arrow
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
  const gas =
    onGasLevel === undefined ? (
      <span className="zb-dseg zb-gas" tabIndex={0} aria-describedby={ids.gas} data-fee="gas" {...hoverProps("gas")}>
        <GasCan title="Gas" level={gasLevel} />
      </span>
    ) : (
      <button type="button" className="zb-dseg zb-gas" aria-label={`Gas level: ${GAS_LEVEL_NAMES[level]}. Change`} aria-describedby={ids.gas} data-fee="gas" data-level={gasLevel} onClick={() => onGasLevel(nextGasLevel(gasLevel))} onKeyDown={levelKeys} {...hoverProps("gas")}>
        <GasCan title="Gas" level={gasLevel} />
      </button>
    );
  const tooltip = hover === "tip" && open === null ? <Tip id={ids.tip} text={`${summaryFull}. Tap for the delivery settings.`} /> : hover === "gas" ? <Tip id={ids.gas} text={gasHelp} /> : hover === "time" && open === null ? <Tip id={ids.time} text="How long until it arrives. Tap for every step." /> : null;

  return (
    <div ref={root}>
      <div className="zb-joined zb-dctl">
        <button type="button" className="zb-dseg zb-dsummary" aria-expanded={open === "tip"} aria-controls={ids.drawer} aria-label={`Delivery settings: ${summaryFull}`} aria-describedby={ids.tip} data-fee="tip" onClick={(event) => pick(event, "tip")} {...hoverProps("tip")}>
          <TakeMyMoney />
          <span className="zb-dsummary-text">{summary}</span>
          <Chevron dir={open === "tip" ? "up" : "down"} />
        </button>
        {gas}
        <button type="button" className="zb-dseg zb-dtime" aria-expanded={open === "time"} aria-controls={ids.drawer} aria-describedby={ids.time} data-fee="time" onClick={(event) => pick(event, "time")} {...hoverProps("time")}>
          <ClockIcon title="Time" />
          {time}
        </button>
        {tooltip}
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
              menu
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
  // The recommended tick first: it is the one a reset goes back to, so its label is the last to give way.
  const ticks = [...(slider.recommended === undefined ? [] : [{ at: slider.recommended.at, label: "recommended" }]), ...slider.ticks];
  const track = useRef<HTMLDivElement>(null);
  const width = useTrackWidth(track);
  const placed = tickLabels(ticks.map((tick) => ({ label: tick.label, left: share(tick.at) })), width);
  // A tick whose label would touch another keeps its mark; its name moves into the control's help.
  const help = placed.hidden.length === 0 ? slider.help : `${slider.help} Also marked on the track: ${placed.hidden.join(", ")}.`;
  const reset = slider.recommended !== undefined && slider.recommended.differs ? slider.recommended : null;
  // A reset can be undone in one step, right where the reset was ("Back to your 0.44%"), until the user changes this
  // value or anything else (owner: a reset must be reversible).
  const root = useRef<HTMLDivElement>(null);
  const [undo, setUndo] = useState<{ readonly label: ReactNode; readonly restore: () => void } | null>(null);
  useEffect(() => {
    if (undo === null) return;
    const elsewhere = (event: Event): void => {
      if (root.current !== null && !root.current.contains(event.target as Node)) setUndo(null);
    };
    document.addEventListener("input", elsewhere, true);
    document.addEventListener("click", elsewhere, true);
    return () => {
      document.removeEventListener("input", elsewhere, true);
      document.removeEventListener("click", elsewhere, true);
    };
  }, [undo]);
  // Moving this value away from the recommendation (by hand, or by the undo itself) ends the offer.
  useEffect(() => {
    if (reset !== null) setUndo(null);
  }, [reset]);
  const resetNow = (onReset: () => void): void => {
    const input = slider.input;
    const before = slider.value;
    const label: ReactNode =
      input === undefined ? (
        "Back to your earlier value"
      ) : (
        <>
          Back to your {input.text}
          {typeof input.unit === "string" ? (input.unit === "%" ? "%" : ` ${input.unit}`) : <> {input.unit}</>}
        </>
      );
    const restore = input === undefined ? () => slider.onChange(before) : ((text: string) => () => input.onText(text))(input.text);
    onReset();
    setUndo({ label, restore });
  };
  const action =
    reset !== null
      ? { label: "Reset to recommended" as ReactNode, onClick: () => resetNow(reset.onReset) }
      : undo !== null
        ? { label: undo.label, onClick: () => { setUndo(null); undo.restore(); } }
        : (slider.status?.action ?? null);
  const errors = slider.input === undefined ? null : <ExactInput label={slider.label} input={slider.input} />;
  return (
    <div className="zb-slider" ref={root}>
      <div className="zb-slider-top">
        <span className="zb-label">
          {slider.label}
          <HelpButton label={slider.label} text={help} />
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
            <button type="button" className="zb-link" data-undo={undo !== null && reset === null ? "" : undefined} onClick={action.onClick}>
              {action.label}
            </button>
          )}
        </div>
      )}
      <div className="zb-range" ref={track}>
        <span className="zb-range-bar" />
        {slider.band === undefined ? null : (
          <span className="zb-range-band" title={slider.band.label} aria-label={slider.band.label} role="img" style={{ left: `${share(Math.min(slider.band.from, slider.band.to))}%`, width: `${Math.max(1, share(Math.max(slider.band.from, slider.band.to)) - share(Math.min(slider.band.from, slider.band.to)))}%` }} />
        )}
        {slider.band?.mark === undefined ? null : <span className="zb-range-anchor" style={{ left: `${share(slider.band.mark)}%` }} />}
        <span className="zb-range-fill" style={{ width: `${share(slider.value)}%` }} />
        {ticks.map((tick) => (
          <span key={tick.label} className="zb-range-tick" data-recommended={tick.label === "recommended" ? "" : undefined} title={tick.label} style={{ left: `${share(tick.at)}%` }} />
        ))}
        <span className="zb-range-knob" style={{ left: `${share(slider.value)}%` }} />
        <input type="range" aria-label={slider.label} min={slider.min} max={slider.max} step={slider.step} value={slider.value} onChange={(event) => slider.onChange(Number(event.target.value))} />
      </div>
      {placed.shown.length === 0 ? null : (
        <div className="zb-ticks">
          {placed.shown.map((tick) => (
            // Shifted by its own position, so a label at either end stays inside the track (centred in the middle).
            <span key={tick.label} style={{ left: `${tick.left}%`, transform: `translateX(-${tick.left}%)` }}>
              {tick.label}
            </span>
          ))}
        </div>
      )}
      {slider.note === undefined ? null : <p className="zb-slider-band-note">{slider.note}</p>}
    </div>
  );
};

/** The track width assumed before it is measured (and in tests, where nothing has a size): a phone's column. */
const ASSUMED_TRACK_PX = 320;
/** The width of one character of a tick label (13 px text), a little generous so labels never touch. */
const TICK_CHAR_PX = 7.2;
/** The least space between two labels. */
const TICK_GAP_PX = 10;

/** The width of the slider's track in pixels, followed as the layout changes; the assumed width until it is known. */
const useTrackWidth = (ref: { readonly current: HTMLElement | null }): number => {
  const [width, setWidth] = useState(ASSUMED_TRACK_PX);
  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const measure = (): void => {
      const measured = element.getBoundingClientRect().width;
      if (measured > 0) setWidth(measured);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return width;
};

/**
 * Places slider tick labels on one row, never overlapping (owner: labels stacked two or three rows deep were not
 * legible). Labels are taken in the order given (the most important first); one that would touch a label already
 * placed is left out, its tick still drawn, and named in `hidden` for the control's help. A label sits at its tick,
 * shifted by its own position so the ends stay inside the track.
 *
 * @param ticks The labels with their position along the track, in percent, most important first.
 * @param trackPx The track's width in pixels.
 */
export const tickLabels = (ticks: readonly { readonly label: string; readonly left: number }[], trackPx: number): { readonly shown: readonly { readonly label: string; readonly left: number }[]; readonly hidden: readonly string[] } => {
  const spanOf = (tick: { readonly label: string; readonly left: number }): readonly [number, number] => {
    const width = tick.label.length * TICK_CHAR_PX;
    const start = (tick.left / 100) * trackPx - (tick.left / 100) * width;
    return [start, start + width];
  };
  const shown: { readonly label: string; readonly left: number }[] = [];
  const hidden: string[] = [];
  for (const tick of ticks) {
    const [start, end] = spanOf(tick);
    const clear = shown.every((other) => {
      const [otherStart, otherEnd] = spanOf(other);
      return end + TICK_GAP_PX <= otherStart || otherEnd + TICK_GAP_PX <= start;
    });
    if (clear) shown.push(tick);
    else hidden.push(tick.label);
  }
  return { shown: [...shown].sort((a, b) => a.left - b.left), hidden };
};
