/**
 * The controls of the browse lists, all menus and no native `<select>` (owner, 2026-11-06: "i must stress that you must
 * not use select tags. only menu."). Each choice is the pill trigger and the one menu surface (.zb-m-surface) the
 * direction menu uses. The bar is sequential rather than a wall of fields (owner: "too cluttered. needs organization /
 * sequential presentation of options"): the primary filters are pills, a Filters pill opens a menu that lists the rest in
 * a fixed order and opens each one's options in turn, and Sort sits at the right. A trigger's chevron is centred on the
 * pill's axis the way the search band's x is ("your chevron must be centered like the x is").
 *
 * Keyboard: Enter, Space or Down opens a menu and puts focus on the current choice; Up and Down (and Home and End) move;
 * Enter picks; Right opens a filter in the Filters menu and Left goes back; Escape closes and returns focus to the pill.
 */
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Chevron } from "../bridge/icons";

/** One choice of a menu. A disabled one stays listed and says why. */
export type Choice = { readonly value: string; readonly label: string; readonly disabled?: boolean };

/** A filter that is a list of choices (the first, empty one is "any"). */
export type MenuFilter = { readonly kind: "menu"; readonly key: string; readonly label: string; readonly any: string; readonly options: readonly Choice[] };
/** A filter that is typed: it applies on Enter or the Apply button and says why a value is refused. */
export type TextFilter = { readonly kind: "text"; readonly key: string; readonly label: string; readonly placeholder: string; readonly accepts: RegExp; readonly why: string };
export type FilterDef = MenuFilter | TextFilter;

const ITEMS = '[role="menuitem"]:not([aria-disabled="true"]), [role="menuitemradio"]:not([aria-disabled="true"]), input';

type Api = { readonly close: () => void; readonly focusFirst: () => void };

/** The pill that opens a menu, and the menu under it. `children` draws the menu's rows. */
const Pop = ({ label, text, set, count, align = "start", children }: { readonly label: string; readonly text: ReactNode; readonly set: boolean; readonly count?: number; readonly align?: "start" | "end"; readonly children: (api: Api) => ReactNode }) => {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const items = (): HTMLElement[] => [...(surface.current?.querySelectorAll<HTMLElement>(ITEMS) ?? [])];
  const focusFirst = (): void => (items().find((item) => item.getAttribute("aria-checked") === "true") ?? items()[0])?.focus();
  const close = (): void => {
    setOpen(false);
    trigger.current?.focus();
  };
  useEffect(() => {
    if (open) focusFirst();
  }, [open]);

  const onKey = (event: KeyboardEvent): void => {
    const all = items();
    const at = all.indexOf(document.activeElement as HTMLElement);
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === "Tab") {
      setOpen(false);
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      all[(at + (event.key === "ArrowDown" ? 1 : -1) + all.length) % all.length]?.focus();
    } else if (event.key === "Home" || event.key === "End") {
      if ((event.target as HTMLElement).tagName === "INPUT") return;
      event.preventDefault();
      all[event.key === "Home" ? 0 : all.length - 1]?.focus();
    }
  };

  return (
    <div
      ref={wrap}
      className="zb-mwrap"
      data-align={align}
      onBlur={(event) => {
        if (open && !wrap.current?.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <button
        ref={trigger}
        type="button"
        className="zb-pill zb-mtrig"
        data-set={set}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && !open) {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span className="zb-mtrig-t">{label}{text === null ? null : <>: {text}</>}</span>
        {count === undefined || count === 0 ? null : <b className="zb-mtrig-n">{count}</b>}
        <Chevron />
      </button>
      {open ? (
        <div ref={surface} className="zb-m-surface zb-bmenu" role="menu" aria-label={label} tabIndex={-1} onKeyDown={onKey}>
          {children({ close, focusFirst })}
        </div>
      ) : null}
    </div>
  );
};

const Rows = ({ options, value, onPick, close }: { readonly options: readonly Choice[]; readonly value: string; readonly onPick: (value: string) => void; readonly close: () => void }) => (
  <>
    {options.map((option) => (
      <button
        key={option.value}
        type="button"
        role="menuitemradio"
        className="zb-m-row"
        aria-checked={option.value === value}
        aria-disabled={option.disabled === true}
        tabIndex={-1}
        onClick={() => {
          if (option.disabled === true) return;
          onPick(option.value);
          close();
        }}
      >
        {option.label}
      </button>
    ))}
  </>
);

/** A pill whose menu is one list of choices: a primary filter, or Sort. */
export const ChoicePill = ({ label, value, any, options, onPick, align, alwaysShowValue = false }: { readonly label: string; readonly value: string; readonly any: string; readonly options: readonly Choice[]; readonly onPick: (value: string) => void; readonly align?: "start" | "end"; readonly alwaysShowValue?: boolean }) => {
  const all: readonly Choice[] = any === "" ? options : [{ value: "", label: any }, ...options];
  const shown = all.find((option) => option.value === value)?.label ?? null;
  return (
    <Pop label={label} text={value === "" && !alwaysShowValue ? null : shown} set={value !== "" && !alwaysShowValue} align={align}>
      {({ close }) => <Rows options={all} value={value} onPick={onPick} close={close} />}
    </Pop>
  );
};

/** The text of a value as a filter shows it: a choice's label, or a typed value as typed. */
export const valueLabel = (def: FilterDef, value: string | undefined): string | null => {
  if (value === undefined) return null;
  if (def.kind === "menu") return def.options.find((option) => option.value === value)?.label ?? value;
  return value.length <= 14 ? value : `${value.slice(0, 8)}…${value.slice(-4)}`;
};

/** The body of the Filters menu: the filters in order, then one filter's options on its own page. */
const FiltersBody = ({ defs, filters, onApply, api }: { readonly defs: readonly FilterDef[]; readonly filters: Readonly<Record<string, string>>; readonly onApply: (key: string, value: string | null) => void; readonly api: Api }) => {
  const [view, setView] = useState<string | null>(null);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) first.current = false;
    else api.focusFirst();
  }, [view]);
  const def = defs.find((candidate) => candidate.key === view);
  if (def === undefined) {
    return (
      <>
        <div className="zb-m-head">Filter by</div>
        {defs.map((entry) => (
          <button key={entry.key} type="button" role="menuitem" aria-haspopup="menu" className="zb-m-row" tabIndex={-1} onClick={() => setView(entry.key)} onKeyDown={(event) => event.key === "ArrowRight" && setView(entry.key)}>
            <span>{entry.label}</span>
            <span className="zb-m-sub zb-m-aside">{valueLabel(entry, filters[entry.key]) ?? "Any"}</span>
            <Chevron dir="right" />
          </button>
        ))}
      </>
    );
  }
  const back = (
    <button type="button" role="menuitem" className="zb-m-row zb-m-back" tabIndex={-1} onClick={() => setView(null)} onKeyDown={(event) => event.key === "ArrowLeft" && setView(null)}>
      <Chevron dir="left" />
      <span>Filters</span>
    </button>
  );
  if (def.kind === "menu") {
    return (
      <div onKeyDown={(event) => event.key === "ArrowLeft" && setView(null)} role="none">
        {back}
        <div className="zb-m-head">{def.label}</div>
        <Rows options={[{ value: "", label: def.any }, ...def.options]} value={filters[def.key] ?? ""} onPick={(value) => onApply(def.key, value)} close={api.close} />
      </div>
    );
  }
  return (
    <div role="none">
      {back}
      <div className="zb-m-head">{def.label}</div>
      <TextEntry def={def} value={filters[def.key] ?? ""} onApply={(value) => { onApply(def.key, value); api.close(); }} />
    </div>
  );
};

/** A typed filter inside the menu: applies on Enter or Apply, refuses what the list cannot use and says why. */
const TextEntry = ({ def, value, onApply }: { readonly def: TextFilter; readonly value: string; readonly onApply: (value: string | null) => void }) => {
  const [text, setText] = useState(value);
  const trimmed = text.trim();
  const refused = trimmed !== "" && !def.accepts.test(trimmed);
  const apply = (): void => {
    if (!refused) onApply(trimmed === "" ? null : trimmed);
  };
  return (
    <div className="zb-m-entry" role="none">
      <input className="zb-menu-field" type="text" aria-label={def.label} placeholder={def.placeholder} spellCheck={false} autoComplete="off" value={text} aria-invalid={refused} onChange={(event) => setText(event.target.value)} onKeyDown={(event) => event.key === "Enter" && (event.preventDefault(), apply())} />
      {refused ? <small className="zb-bfld-err" role="alert">{def.why}</small> : null}
      <button type="button" role="menuitem" className="zb-pill zb-m-apply" tabIndex={-1} aria-disabled={refused} onClick={apply}>
        Apply
      </button>
    </div>
  );
};

/** The Filters pill: opens the menu of the filters that are not on the bar. */
export const FiltersPill = ({ defs, filters, onApply }: { readonly defs: readonly FilterDef[]; readonly filters: Readonly<Record<string, string>>; readonly onApply: (key: string, value: string | null) => void }) => (
  <Pop label="Filters" text={null} set={defs.some((def) => filters[def.key] !== undefined)} count={defs.filter((def) => filters[def.key] !== undefined).length}>
    {(api) => <FiltersBody defs={defs} filters={filters} onApply={onApply} api={api} />}
  </Pop>
);

/** The active filters as removable chips, with Clear all. */
export const FilterChips = ({ chips, onRemove, onClear }: { readonly chips: readonly { readonly key: string; readonly label: string; readonly text: string }[]; readonly onRemove: (key: string) => void; readonly onClear: () => void }) =>
  chips.length === 0 ? null : (
    <ul className="zb-bchips" aria-label="Active filters">
      {chips.map((chip) => (
        <li key={chip.key}>
          <button type="button" className="zb-chip" aria-label={`Remove filter ${chip.label}: ${chip.text}`} onClick={() => onRemove(chip.key)}>
            <span>{chip.label}: {chip.text}</span>
            <svg viewBox="0 0 12 12" className="zb-icon" aria-hidden="true" focusable="false">
              <path d="M3 3l6 6M9 3 3 9" />
            </svg>
          </button>
        </li>
      ))}
      <li>
        <button type="button" className="zb-link zb-bclear" onClick={onClear}>
          Clear all
        </button>
      </li>
    </ul>
  );
