import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Sheet } from "../bridge/Sheet";
import { SearchIcon } from "../bridge/icons";
import { usePaletteSearch } from "./use-palette-search";
import { actionResults, moveHighlight, viewResults, type MoveKey, type SearchResult } from "./search-model";
import { useServices } from "../app/services";
import type { DocPage } from "../docs/docs-index";

/** Props of {@link CommandPalette}. */
export type CommandPaletteProps = {
  readonly recent: readonly SearchResult[];
  readonly walletConnected: boolean;
  /** Called with the result that the user picked. The caller jumps and closes. */
  readonly onSelect: (result: SearchResult) => void;
  readonly onClose: () => void;
  /** Replaces the documentation pages. Tests use it. */
  readonly docPages?: readonly DocPage[];
};

const MOVE_KEYS: readonly string[] = ["ArrowDown", "ArrowUp", "Home", "End"];

/**
 * The search and quick navigation, drawn like the token picker (owner: the search band is a burn streak edge to edge,
 * with a square close flush right). One field finds views, pairs, tokens, transfers by identifier or transaction hash,
 * addresses, slots, blocks, proofs, releases, actions and documentation. A result of the shared search shows its links to the
 * other pages (Explore, the indexer, the status page, the backend, the block explorers) under its text. The arrow keys move through the results, Enter opens one, Escape closes.
 *
 * @param props The recent results, the wallet state and the handlers.
 */
export const CommandPalette = ({ recent, walletConnected, onSelect, onClose, docPages }: CommandPaletteProps) => {
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const inputReference = useRef<HTMLInputElement>(null);
  const listId = useId();
  const search = usePaletteSearch({ query, recent, walletConnected, ...(docPages === undefined ? {} : { docPages }) });
  const active = search.flat[highlight] ?? null;
  const { pair } = useServices();
  // The footer's quick links are the palette's own Settings action and Docs view, so they open exactly what those rows open.
  const quickLinks = [...actionResults({ pair, walletConnected }), ...viewResults(pair.id)].filter((result) => result.id === "action:settings" || result.id === "view:docs");
  const optionId = useCallback((result: SearchResult): string => `${listId}-${result.id}`, [listId]);

  useEffect(() => {
    if (active === null) return;
    document.getElementById(optionId(active))?.scrollIntoView?.({ block: "nearest" });
  }, [active, optionId]);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (MOVE_KEYS.includes(event.key)) {
      event.preventDefault();
      setHighlight((current) => moveHighlight(current, search.flat.length, event.key as MoveKey));
      return;
    }
    if (event.key !== "Enter" || active === null) return;
    event.preventDefault();
    onSelect(active);
  };

  return (
    <Sheet label="Search and jump" showTitle={false} bare top onClose={onClose}>
      <div className="zb-picker-search">
        <SearchIcon />
        <input
          ref={inputReference}
          role="combobox"
          aria-label="Search views, pairs, tokens, transfers, transactions, addresses, blocks, proofs, actions and docs"
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={active === null ? undefined : optionId(active)}
          placeholder="Search anything"
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
          {search.groups.map((group) => (
            <div key={group.id} role="group" aria-labelledby={`${listId}-group-${group.id}`}>
              <div id={`${listId}-group-${group.id}`} className="zb-m-head">
                {group.title}
              </div>
              {group.results.map((result) => (
                <div
                  key={result.id}
                  id={optionId(result)}
                  role="option"
                  aria-selected={active !== null && active.id === result.id}
                  className="zb-m-row zb-m-stack"
                  onMouseMove={() => setHighlight(search.flat.findIndex((candidate) => candidate.id === result.id))}
                  onClick={() => onSelect(result)}
                >
                  <span className="zb-m-title">{result.title}</span>
                  <span className="zb-m-sub">{result.subtitle}</span>
                  {result.links === undefined || result.links.length === 0 ? null : (
                    <span className="zb-m-xlinks" aria-label="The same on other pages">
                      {result.links.map((link, index) => (
                        <span key={`${link.surface}:${link.url}`}>
                          {index === 0 ? null : " · "}
                          <a
                            href={link.url}
                            {...(link.surface === "dapp" ? {} : { target: "_blank", rel: "noreferrer" })}
                            onClick={(event) => {
                              event.stopPropagation();
                              if (link.surface !== "dapp") return;
                              event.preventDefault();
                              onSelect(result);
                            }}
                          >
                            {link.label}
                          </a>
                        </span>
                      ))}
                    </span>
                  )}
                </div>
              ))}
            </div>
          ))}
          {search.groups.length === 0 && !search.loading ? (
            <p className="zb-m-note">{search.problem ?? "Nothing matches. Try a token symbol, an address, a transaction hash or a word from the docs."}</p>
          ) : null}
          {search.loading ? (
            <p className="zb-m-note" role="status">
              Asking the indexer…
            </p>
          ) : null}
          {search.groups.length > 0 && search.problem !== null ? (
            <p className="zb-m-note" role="status">
              {search.problem}
            </p>
          ) : null}
        </div>
      </div>
      <div className="zb-m-foot">
        <span className="zb-m-keys" aria-hidden="true">
          <kbd>↑</kbd>
          <kbd>↓</kbd> move <kbd>↵</kbd> open <kbd>esc</kbd> close
        </span>
        <span className="zb-m-links">
          {quickLinks.map((result) => (
            <button key={result.id} type="button" onClick={() => onSelect(result)}>
              {result.title}
            </button>
          ))}
        </span>
      </div>
    </Sheet>
  );
};
