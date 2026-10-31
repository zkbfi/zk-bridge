import { useEffect, useId, useMemo, useState, type KeyboardEvent } from "react";
import { Sheet } from "@web/bridge/Sheet";
import { SearchIcon } from "@web/bridge/icons";
import { Marked } from "@web/explore/parts";
import { moveHighlight, type MoveKey } from "@web/search/search-model";
import { searchDocs, type DocsResult } from "./docs-search";
import type { DocsSitePage } from "./pages";

/** Props of {@link DocsSearch}. */
export type DocsSearchProps = {
  readonly pages: readonly DocsSitePage[];
  /** Called with the row the reader picked. The caller jumps and closes. */
  readonly onSelect: (result: DocsResult) => void;
  readonly onClose: () => void;
};

const MOVE_KEYS: readonly string[] = ["ArrowDown", "ArrowUp", "Home", "End"];
const FOCUSABLE = 'input, button, a[href], [tabindex]:not([tabindex="-1"])';

/**
 * Keeps Tab inside the dialog: from the last control it goes back to the field, and Shift+Tab from the field goes to
 * the last control.
 */
const keepTabInside = (event: KeyboardEvent<HTMLElement>): void => {
  if (event.key !== "Tab") return;
  const dialog = event.currentTarget.closest('[role="dialog"]');
  const controls = dialog === null ? [] : [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)];
  const first = controls[0];
  const last = controls[controls.length - 1];
  if (first === undefined || last === undefined) return;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
};

/**
 * The docs search, the app's search sheet over the pages: the orange band edge to edge with the square close flush
 * right, rows marked by the accent edge, a footer with the keys. The arrow keys move, Enter opens, Escape closes, and
 * Tab stays inside.
 *
 * @param props The pages and the handlers.
 */
export const DocsSearch = ({ pages, onSelect, onClose }: DocsSearchProps) => {
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const listId = useId();
  const groups = useMemo(() => searchDocs(query, pages), [query, pages]);
  const flat = useMemo(() => groups.flatMap((group) => group.results), [groups]);
  const active = flat[highlight] ?? null;
  const optionId = (result: DocsResult): string => `${listId}-${result.id.replace(/[^A-Za-z0-9_-]/g, "_")}`;

  useEffect(() => {
    // The row ids depend only on listId, which never changes.
    if (active !== null) document.getElementById(optionId(active))?.scrollIntoView?.({ block: "nearest" });
  }, [active]);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (MOVE_KEYS.includes(event.key)) {
      event.preventDefault();
      setHighlight((current) => moveHighlight(current, flat.length, event.key as MoveKey));
      return;
    }
    if (event.key !== "Enter" || active === null) return;
    event.preventDefault();
    onSelect(active);
  };

  return (
    <Sheet label="Search the docs" showTitle={false} bare top onClose={onClose}>
      <div className="zd-contents" onKeyDown={keepTabInside}>
        <div className="zb-picker-search">
          <SearchIcon />
          <input
            role="combobox"
            aria-label="Search the docs: pages, sections and the theme"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={active === null ? undefined : optionId(active)}
            placeholder="Search the docs"
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setHighlight(0);
            }}
            onKeyDown={onKeyDown}
          />
          <button type="button" className="zb-picker-close" aria-label="Close" onClick={onClose}>
            <svg viewBox="0 0 12 12" className="zb-icon" aria-hidden="true" focusable="false">
              <path d="M3 3l6 6M9 3 3 9" />
            </svg>
          </button>
        </div>
        <div className="zb-picker zb-palette">
          <div id={listId} role="listbox" aria-label="Results" className="zb-palette-list">
            {groups.map((group) => (
              <div key={group.id} role="group" aria-labelledby={`${listId}-g-${group.id}`}>
                <div id={`${listId}-g-${group.id}`} className="zb-palette-group">
                  {group.title}
                </div>
                {group.results.map((result) => (
                  <div
                    key={result.id}
                    id={optionId(result)}
                    role="option"
                    aria-selected={active !== null && active.id === result.id}
                    className="zb-palette-row"
                    onMouseMove={() => setHighlight(flat.findIndex((candidate) => candidate.id === result.id))}
                    onClick={() => onSelect(result)}
                  >
                    <span className="zb-palette-title">
                      <Marked text={result.title} match={query.trim() === "" ? null : query.trim()} />
                    </span>
                    {result.subtitle === "" ? null : <span className="zb-palette-sub">{result.subtitle}</span>}
                  </div>
                ))}
              </div>
            ))}
            {groups.length === 0 ? <p className="zb-palette-note">Nothing matches. Try a word from a page title or a heading, such as fee, proof or gate.</p> : null}
          </div>
        </div>
        <div className="zb-palette-foot">
          <span className="zb-palette-keys" aria-hidden="true">
            <kbd>↑</kbd>
            <kbd>↓</kbd> move <kbd>↵</kbd> open <kbd>esc</kbd> close
          </span>
          <span className="zb-palette-links">
            <button type="button" onClick={() => onSelect({ id: "page:", title: "Docs home", subtitle: "", href: "#/" })}>
              Docs home
            </button>
          </span>
        </div>
      </div>
    </Sheet>
  );
};
