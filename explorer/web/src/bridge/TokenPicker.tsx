import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { isNativeToken, tokenBalance } from "./bridge-model";
import type { ChainSnapshotResult } from "@terminal/chain/live-reads";
import type { ChainSide, TokenInfo } from "@terminal/model/types";
import { useServices } from "../app/services";
import { amountText } from "./bridge-model";
import { isTokenAddress } from "./custom-token";
import { Chevron, SearchIcon } from "./icons";
import { iconSubjectOf } from "./image-source";
import { Num } from "./Num";
import { Sheet } from "./Sheet";
import { TokenIcon } from "./TokenIcon";

/** Props of {@link TokenPicker}. */
export type TokenPickerProps = {
  readonly tokens: readonly TokenInfo[];
  readonly selected: TokenInfo;
  readonly snapshots: readonly ChainSnapshotResult[];
  /** Tokens the wallet used or bridged with zkb.fi before (from the indexer), listed even with no balance now. */
  readonly used?: ReadonlySet<string>;
  /** The unit price of a token in dollars as a plain decimal text, or null while no price source exists. */
  readonly priceOf?: (token: TokenInfo) => string | null;
  /** For a token that is an Omnibridge copy, the native token it wraps; else null. */
  readonly omnibridgeNativeOf?: (token: TokenInfo) => TokenInfo | null;
  /** Reads a pasted address that is in no list (custom tokens), on the given chain; null when it is not a token. */
  readonly resolveCustom?: (address: string, side: ChainSide) => Promise<TokenInfo | null>;
  readonly onPick: (token: TokenInfo) => void;
  readonly onClose: () => void;
};

type Tab = "all" | ChainSide;

const keyOf = (token: TokenInfo): string => `${token.side}:${token.address.toLowerCase()}`;

/** The user's balance of a token, from the snapshots, or null when unknown. */
const balanceOf = (token: TokenInfo, snapshots: readonly ChainSnapshotResult[]): bigint | null => tokenBalance(token, snapshots);

/**
 * Which rows the picker shows: without a query, the native coin of each chain, then the user's tokens (held now, or used or
 * bridged with zkb.fi before); with a query, every bridgeable token. The tab narrows to a chain. When a chain's balances
 * are unknown (still loading, or the read failed), that chain lists all its bridgeable tokens: hiding them would leave the
 * user with nothing to pick ("the token is not presented to the user").
 */
export const pickerRows = (input: {
  readonly tokens: readonly TokenInfo[];
  readonly snapshots: readonly ChainSnapshotResult[];
  readonly used?: ReadonlySet<string>;
  readonly query: string;
  readonly tab: Tab;
  readonly selected: TokenInfo;
}): readonly TokenInfo[] => {
  const query = input.query.trim().toLowerCase();
  const known = (side: ChainSide): boolean => input.snapshots.some((result) => result.status === "ok" && result.snapshot.chain.side === side);
  return input.tokens.filter((token) => {
    if (input.tab !== "all" && token.side !== input.tab) return false;
    if (query !== "") return token.symbol.toLowerCase().includes(query) || token.address.toLowerCase().includes(query);
    if (isNativeToken(token) || !known(token.side)) return true;
    const balance = balanceOf(token, input.snapshots);
    return (balance !== null && balance > 0n) || input.used?.has(keyOf(token)) === true || token === input.selected;
  });
};

/** "All chains": four small circles in a 2×2 grid. */
const AllChainsIcon = () => (
  <svg viewBox="0 0 20 20" width="20" height="20" className="zb-icon" aria-hidden="true" focusable="false" style={{ width: 20, height: 20 }}>
    <circle cx="6" cy="6" r="3.2" />
    <circle cx="14" cy="6" r="3.2" />
    <circle cx="6" cy="14" r="3.2" />
    <circle cx="14" cy="14" r="3.2" />
  </svg>
);

/** A small bridge: marks a token that came over the Omnibridge. */
const BridgeGlyph = () => (
  <svg viewBox="0 0 20 14" width="18" height="13" className="zb-icon" aria-hidden="true" focusable="false" style={{ width: 18, height: 13 }}>
    <path d="M1 11h18M3 11V7a7 5 0 0 1 14 0v4M7 11V8M10 11V7M13 11V8" />
  </svg>
);

/**
 * The token picker (owner, rounds 3 to 7). On phones it rises from the bottom edge, full width; on desktop it is a
 * centred modal. The search is a 52 px orange band like the amount band, no pill and no top border, with a 52×52
 * close square of the same orange set off by a dark rule on its left. Tabs: an "all chains" icon, then each chain's
 * icon (no names). Rows: the token icon with its ORIGIN chain's badge, the symbol, the unit price under it, and the
 * balance on the right. An Omnibridge copy carries a bridge icon whose tooltip explains the double-wrap risk and links
 * to the native token. The selected row is lit with a left accent bar that never shifts content. No helper copy.
 *
 * @param props The tokens, the selection, the balances and the handlers.
 */
export const TokenPicker = ({ tokens, selected, snapshots, used, priceOf = () => null, omnibridgeNativeOf = () => null, resolveCustom, onPick, onClose }: TokenPickerProps) => {
  const { pair } = useServices();
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<Tab>("all");
  const [focused, setFocused] = useState<string | null>(null);
  const [tip, setTip] = useState<string | null>(null);
  const [custom, setCustom] = useState<TokenInfo | "loading" | "none" | null>(null);
  const listed = useMemo(() => pickerRows({ tokens, snapshots, used, query, tab, selected }), [tokens, snapshots, used, query, tab, selected]);
  const rows = useMemo(() => (custom !== null && typeof custom === "object" ? [...listed, custom] : listed), [listed, custom]);
  // A pasted address that is in no list is read on-chain (on the chosen tab's chain, else the sending chain).
  useEffect(() => {
    const text = query.trim();
    if (resolveCustom === undefined || !isTokenAddress(text) || tokens.some((token) => token.address.toLowerCase() === text.toLowerCase())) {
      setCustom(null);
      return;
    }
    let live = true;
    setCustom("loading");
    void resolveCustom(text, tab === "all" ? selected.side : tab).then((found) => {
      if (live) setCustom(found ?? "none");
    });
    return () => {
      live = false;
    };
  }, [query, tab, tokens, resolveCustom, selected.side]);
  const [active, setActive] = useState(0);
  const chainOf = (side: ChainSide) => (side === "first" ? pair.first : pair.second);

  const onKey = (event: KeyboardEvent): void => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setActive((at) => (at + (event.key === "ArrowDown" ? 1 : -1) + rows.length) % Math.max(1, rows.length));
    } else if (event.key === "Enter" && rows[active] !== undefined) {
      event.preventDefault();
      onPick(rows[active]!);
    }
  };

  const jumpTo = (native: TokenInfo): void => {
    setQuery(native.address);
    setTab(native.side);
    setTip(null);
    setFocused(keyOf(native));
  };

  return (
    <Sheet label="Choose a token" showTitle={false} bare onClose={onClose}>
      <div className="zb-picker-search" onKeyDown={onKey}>
        <div className="zb-picker-in">
          <SearchIcon />
          <input aria-label="Search tokens" role="combobox" aria-expanded="true" aria-controls="zb-token-list" placeholder="Search" spellCheck={false} autoComplete="off" value={query} onChange={(event) => { setQuery(event.target.value); setActive(0); }} />
          <button type="button" className="zb-picker-close" aria-label="Close" onClick={onClose}>
            <svg viewBox="0 0 12 12" className="zb-icon" aria-hidden="true" focusable="false">
              <path d="M3 3l6 6M9 3 3 9" />
            </svg>
          </button>
        </div>
      </div>
      <div className="zb-picker">
        <div className="zb-tabs" role="tablist" aria-label="Chain">
          {(["all", "first", "second"] as const).map((key) => (
            <button key={key} type="button" role="tab" aria-selected={tab === key} aria-label={key === "all" ? "All chains" : chainOf(key).name} onClick={() => { setTab(key); setActive(0); }}>
              {key === "all" ? <AllChainsIcon /> : <TokenIcon subject={{ chainId: chainOf(key).chainId }} symbol={chainOf(key).name} size={20} decorative />}
            </button>
          ))}
        </div>
        <ul id="zb-token-list" className="zb-m-list" role="listbox" aria-label="Tokens">
          {rows.map((token, index) => {
            const balance = balanceOf(token, snapshots);
            const subject = iconSubjectOf(token, pair);
            const price = priceOf(token);
            const native = omnibridgeNativeOf(token);
            const key = keyOf(token);
            return (
              <li
                key={key}
                role="option"
                className="zb-m-row zb-m-tall"
                aria-selected={token === selected}
                data-active={index === active || focused === key}
                onClick={() => onPick(token)}
                onMouseEnter={() => setActive(index)}
              >
                <TokenIcon subject={subject} badgeChainId={subject.chainId} symbol={token.symbol} isBridgedCopy={token.isBridgedCopy} size={36} />
                <span className="zb-token-name">
                  <b style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                    {token.symbol}
                    {native === null ? null : (
                      <span
                        className="zb-omni"
                        tabIndex={0}
                        role="button"
                        aria-label="Came over the Omnibridge"
                        aria-expanded={tip === key}
                        onClick={(event) => { event.stopPropagation(); setTip(tip === key ? null : key); }}
                        onKeyDown={(event) => { if (event.key === "Enter") { event.stopPropagation(); setTip(tip === key ? null : key); } }}
                      >
                        <BridgeGlyph />
                        {tip === key ? (
                          <span role="tooltip" className="zb-tooltip" onClick={(event) => event.stopPropagation()}>
                            This {token.symbol} is a copy that came over the Omnibridge. Bridging it with zkb.fi wraps it a second time: you pay gas twice, and it only turns back into {native.symbol} by undoing both bridges in order.{" "}
                            <button type="button" className="zb-link" onClick={() => jumpTo(native)}>
                              Use native {native.symbol} <Chevron dir="right" />
                            </button>
                          </span>
                        ) : null}
                      </span>
                    )}
                  </b>
                  <small>{price === null ? "—" : <>$<Num text={price} /></>}</small>
                </span>
                <span className="zb-token-balance">{balance === null ? null : <Num text={amountText(balance, token.decimals)} />}</span>
              </li>
            );
          })}
        </ul>
        {custom === "loading" ? <p className="zb-picker-note" aria-live="polite">Reading…</p> : custom === "none" ? <p className="zb-picker-note" aria-live="polite">Not a token</p> : null}
      </div>
    </Sheet>
  );
};
