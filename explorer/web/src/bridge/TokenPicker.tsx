import { useMemo, useState, type KeyboardEvent } from "react";
import type { ChainSnapshotResult } from "@terminal/chain/live-reads";
import type { ChainSide, TokenInfo } from "@terminal/model/types";
import { useServices } from "../app/services";
import { amountText } from "./bridge-model";
import { SearchIcon } from "./icons";
import { iconSubjectOf } from "./image-source";
import { Num } from "./Num";
import { CloseButton, Sheet } from "./Sheet";
import { TokenIcon } from "./TokenIcon";

/** Props of {@link TokenPicker}. */
export type TokenPickerProps = {
  readonly tokens: readonly TokenInfo[];
  readonly selected: TokenInfo;
  readonly snapshots: readonly ChainSnapshotResult[];
  readonly onPick: (token: TokenInfo) => void;
  readonly onClose: () => void;
};

type Tab = "all" | ChainSide;

/** The user's balance of a token, from the snapshots, or null when unknown. */
const balanceOf = (token: TokenInfo, snapshots: readonly ChainSnapshotResult[]): bigint | null => {
  const found = snapshots.find((result) => result.status === "ok" && result.snapshot.chain.side === token.side);
  if (found === undefined || found.status !== "ok") return null;
  return found.snapshot.positions.find((position) => position.token.address === token.address)?.balance ?? null;
};

/**
 * Which rows the picker shows: without a query, only the user's tokens (held now; tokens used or bridged with zkb.fi
 * before join once Activity exists); with a query, every bridgeable token on every chain. The tab narrows to a chain.
 */
export const pickerRows = (input: { readonly tokens: readonly TokenInfo[]; readonly snapshots: readonly ChainSnapshotResult[]; readonly query: string; readonly tab: Tab; readonly selected: TokenInfo }): readonly TokenInfo[] => {
  const query = input.query.trim().toLowerCase();
  return input.tokens.filter((token) => {
    if (input.tab !== "all" && token.side !== input.tab) return false;
    if (query !== "") return token.symbol.toLowerCase().includes(query) || token.address.toLowerCase().includes(query);
    const balance = balanceOf(token, input.snapshots);
    return (balance !== null && balance > 0n) || token === input.selected;
  });
};

/**
 * The token picker (owner, round 3): a panel from the bottom edge, full width, on phones and a centred modal on desktop;
 * no title; the close button sits inside the search field on its right; flat text tabs (All, then each chain) with a
 * 3-unit accent underline on the active one; rows with the icon, symbol, chain and balance. The selected row is lit
 * with an accent bar on its left edge, which never shifts content. Picking a token on the other chain flips the
 * direction (the caller does that). No helper copy.
 *
 * @param props The tokens, the selection, the balances and the handlers.
 */
export const TokenPicker = ({ tokens, selected, snapshots, onPick, onClose }: TokenPickerProps) => {
  const { pair } = useServices();
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<Tab>("all");
  const rows = useMemo(() => pickerRows({ tokens, snapshots, query, tab, selected }), [tokens, snapshots, query, tab, selected]);
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

  return (
    <Sheet label="Choose a token" showTitle={false} onClose={onClose}>
      <div className="zb-picker">
        <div className="zb-search-field" onKeyDown={onKey}>
          <SearchIcon />
          <input aria-label="Search tokens" role="combobox" aria-expanded="true" aria-controls="zb-token-list" placeholder="Search" spellCheck={false} autoComplete="off" value={query} onChange={(event) => { setQuery(event.target.value); setActive(0); }} />
          <CloseButton onClose={onClose} />
        </div>
        <div className="zb-tabs" role="tablist" aria-label="Chain">
          {(["all", "first", "second"] as const).map((key) => (
            <button key={key} type="button" role="tab" aria-selected={tab === key} onClick={() => { setTab(key); setActive(0); }}>
              {key === "all" ? "All" : (
                <>
                  <TokenIcon subject={{ chainId: chainOf(key).chainId }} symbol={chainOf(key).name} size={16} decorative />
                  {chainOf(key).name}
                </>
              )}
            </button>
          ))}
        </div>
        <ul id="zb-token-list" className="zb-token-list" role="listbox" aria-label="Tokens">
          {rows.map((token, index) => {
            const balance = balanceOf(token, snapshots);
            const chain = chainOf(token.side);
            return (
              <li
                key={`${token.side}:${token.address}`}
                role="option"
                aria-selected={token === selected}
                data-active={index === active}
                onClick={() => onPick(token)}
                onMouseEnter={() => setActive(index)}
              >
                <TokenIcon subject={iconSubjectOf(token, pair)} badgeChainId={/^zkb/i.test(token.symbol) ? chain.chainId : null} symbol={token.symbol} size={30} />
                <span className="zb-token-name">
                  <b>{token.symbol}</b>
                  <small>{chain.name}</small>
                </span>
                <span className="zb-token-balance">{balance === null ? null : <Num text={amountText(balance, token.decimals)} />}</span>
              </li>
            );
          })}
        </ul>
      </div>
    </Sheet>
  );
};
