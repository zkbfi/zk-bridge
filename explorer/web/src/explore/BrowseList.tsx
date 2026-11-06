/**
 * The paged lists behind Explore's browse tiles: transfers & messages, proofs, tokens and addresses. The indexer does the
 * filtering, sorting and paging (`GET /api/browse/*`); this page holds the view in the hash, so a link opens the same
 * rows and back and forward walk the views. A view reads one snapshot (`asOf`) while a reader pages through it, so rows
 * that arrive meanwhile do not shift the pages; "Refresh" takes a new one.
 */
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useRef, useState, type FormEvent, type ReactNode } from "react";
import type { PairConfig } from "@terminal/model/types";
import { BROWSE_PAGE_SIZE, type BrowseClient, type BrowsePage, type BrowseMessage, type BrowseProof, type BrowseToken, type BrowseAddress } from "@zk-bridge/shared";
import { formatRoute, type ExplorePage } from "../app/route";
import { useTokens } from "../app/queries";
import { useServices } from "../app/services";
import { relativeTime } from "../bridge/activity-model";
import { amountText } from "../bridge/bridge-model";
import { Num } from "../bridge/Num";
import { TokenIcon } from "../bridge/TokenIcon";
import { chainNamer } from "./ExploreScreen";
import { statusWord } from "./explore-model";
import { formatListState, LIST_SPECS, pageCount, parseListState, requestOf, viewKey, withFilter, withPage, withSort, type ListKind, type ListState } from "./browse-model";
import { RouteIcons, shortHex, XGroup, XRow } from "./parts";

const TITLES: Readonly<Record<ListKind, string>> = { transfers: "Transfers & messages", proofs: "Proofs", tokens: "Tokens", addresses: "Addresses" };
const NOUNS: Readonly<Record<ListKind, string>> = { transfers: "transfers and messages", proofs: "light-client updates", tokens: "tokens", addresses: "addresses" };

type Fetched =
  | { readonly kind: "transfers"; readonly page: BrowsePage<BrowseMessage> }
  | { readonly kind: "proofs"; readonly page: BrowsePage<BrowseProof> }
  | { readonly kind: "tokens"; readonly page: BrowsePage<BrowseToken> }
  | { readonly kind: "addresses"; readonly page: BrowsePage<BrowseAddress> };

const fetchPage = async (browse: BrowseClient, kind: ListKind, request: ReturnType<typeof requestOf>): Promise<Fetched> => {
  if (kind === "transfers") return { kind, page: await browse.messages(request) };
  if (kind === "proofs") return { kind, page: await browse.proofs(request) };
  if (kind === "tokens") return { kind, page: await browse.tokens(request) };
  return { kind, page: await browse.addresses(request) };
};

const href = (kind: ListKind, state: ListState): string => formatRoute({ name: "explore", page: { kind: "browse", id: kind, query: formatListState(kind, state) } });
const explore = (page: ExplorePage): string => formatRoute({ name: "explore", page });
const go = (target: string): void => {
  window.location.hash = target;
};

type Option = { readonly value: string; readonly label: string; readonly disabled?: boolean };

const Menu = ({ label, value, options, onChange }: { readonly label: string; readonly value: string; readonly options: readonly Option[]; readonly onChange: (value: string) => void }) => (
  <label className="zb-bfld">
    <span>{label}</span>
    <select className="zb-menu-field" value={value} onChange={(event) => onChange(event.target.value)}>
      {options.map((option) => (
        <option key={option.value} value={option.value} disabled={option.disabled}>
          {option.label}
        </option>
      ))}
    </select>
  </label>
);

/** A box that applies on Enter or when it loses focus, and says why a value is refused. */
const TextFilter = ({ label, value, placeholder, accepts, why, onApply }: { readonly label: string; readonly value: string; readonly placeholder: string; readonly accepts: RegExp; readonly why: string; readonly onApply: (value: string | null) => void }) => {
  const [text, setText] = useState(value);
  const [shown, setShown] = useState(value);
  if (shown !== value) {
    setShown(value);
    setText(value);
  }
  const trimmed = text.trim();
  const refused = trimmed !== "" && !accepts.test(trimmed);
  const apply = (event?: FormEvent): void => {
    event?.preventDefault();
    if (!refused && trimmed !== value) onApply(trimmed === "" ? null : trimmed);
  };
  return (
    <form className="zb-bfld zb-bfld-text" onSubmit={apply}>
      <span>{label}</span>
      <input className="zb-menu-field" type="text" aria-label={label} placeholder={placeholder} spellCheck={false} autoComplete="off" value={text} aria-invalid={refused} onChange={(event) => setText(event.target.value)} onBlur={() => apply()} />
      {refused ? <small className="zb-bfld-err" role="alert">{why}</small> : null}
    </form>
  );
};

const FULL_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ADDRESS_START = /^(0x)?[0-9a-fA-F]{1,40}$/;

const sortLabels: Readonly<Record<string, string>> = {
  newest: "Newest first",
  oldest: "Oldest first",
  "amount-high": "Largest amount first",
  "amount-low": "Smallest amount first",
  "slot-high": "Highest slot first",
  "slot-low": "Lowest slot first",
  symbol: "Symbol, A to Z",
  transfers: "Most transfers",
  activity: "Most active",
  recent: "Most recent activity",
};

const controlsOf = (kind: ListKind, state: ListState, pair: PairConfig, tokens: readonly { readonly side: "first" | "second"; readonly address: string; readonly symbol: string }[], change: (next: ListState) => void): ReactNode => {
  const names = chainNamer(pair);
  const side = (label: string, key: string) => (
    <Menu
      key={key}
      label={label}
      value={state.filters[key] ?? ""}
      options={[{ value: "", label: "Both chains" }, { value: "first", label: names(pair.first.chainId) }, { value: "second", label: names(pair.second.chainId) }]}
      onChange={(value) => change(withFilter(state, key, value))}
    />
  );
  const menu = (label: string, key: string, any: string, options: readonly Option[]) => (
    <Menu key={key} label={label} value={state.filters[key] ?? ""} options={[{ value: "", label: any }, ...options]} onChange={(value) => change(withFilter(state, key, value))} />
  );
  if (kind === "transfers") {
    return (
      <>
        {side("Sent from", "from")}
        {menu("Status", "status", "Any status", [{ value: "inflight", label: "In flight" }, { value: "delivered", label: "Delivered" }, { value: "failed", label: "Failed" }])}
        {menu("Type", "kind", "Transfers and messages", [{ value: "token", label: "Transfers" }, { value: "message", label: "Messages" }])}
        {menu("Token", "token", "Any token", tokens.map((token) => ({ value: `${token.side}:${token.address}`, label: `${token.symbol} on ${names(token.side === "first" ? pair.first.chainId : pair.second.chainId)}` })))}
        {menu("Sent", "since", "Any time", [{ value: "1h", label: "Last hour" }, { value: "24h", label: "Last 24 hours" }, { value: "7d", label: "Last 7 days" }])}
        <TextFilter label="Address" value={state.filters.account ?? ""} placeholder="0x… sender, recipient or executor" accepts={FULL_ADDRESS} why="An address is 0x followed by 40 hex characters." onApply={(value) => change(withFilter(state, "account", value))} />
      </>
    );
  }
  if (kind === "proofs") {
    return (
      <>
        {side("Posted on", "chain")}
        <TextFilter label="Poster" value={state.filters.poster ?? ""} placeholder="0x… who posted it" accepts={FULL_ADDRESS} why="An address is 0x followed by 40 hex characters." onApply={(value) => change(withFilter(state, "poster", value))} />
      </>
    );
  }
  if (kind === "tokens") {
    return (
      <>
        {side("Chain", "chain")}
        {menu("Kind", "kind", "Native and bridged copies", [{ value: "native", label: "Native" }, { value: "copy", label: "Bridged copies" }])}
      </>
    );
  }
  return (
    <>
      {menu("Role", "role", "Any role", [{ value: "sender", label: "Senders" }, { value: "recipient", label: "Receivers" }, { value: "poster", label: "Proof posters" }])}
      <TextFilter label="Starts with" value={state.filters.q ?? ""} placeholder="0x…" accepts={ADDRESS_START} why="Type the start of an address, hex characters only." onApply={(value) => change(withFilter(state, "q", value))} />
    </>
  );
};

const sortOptionsOf = (kind: ListKind, state: ListState): readonly Option[] =>
  LIST_SPECS[kind].sorts.map((value) => {
    // Amounts are base units of one token: comparing tokens with different decimals would put them in the wrong order.
    const needsToken = value.startsWith("amount") && state.filters.token === undefined;
    const waiting = value === "oldest" && state.filters.status === "inflight";
    return { value, label: waiting ? "Waiting longest first" : needsToken ? `${sortLabels[value]} (choose a token)` : (sortLabels[value] as string), disabled: needsToken };
  });

const rowsOf = (fetched: Fetched, pair: PairConfig, now: number): ReactNode => {
  const names = chainNamer(pair);
  const sideOf = (chainId: number): "first" | "second" => (chainId === pair.first.chainId ? "first" : "second");
  const otherOf = (chainId: number): number => (chainId === pair.first.chainId ? pair.second.chainId : pair.first.chainId);
  if (fetched.kind === "transfers") {
    return fetched.page.items.map((item) => {
      const amount = item.token !== null && item.amount !== null && item.token.decimals !== null && item.token.symbol !== null ? { text: amountText(item.amount, item.token.decimals), symbol: item.token.symbol } : null;
      const target = item.sourceTransactionHash === null ? formatRoute({ name: "message", messageId: item.id }) : explore({ kind: "tx", chainId: item.sourceChainId, id: item.sourceTransactionHash });
      return (
        <XRow
          key={item.id}
          href={target}
          title={amount === null ? `Message ${shortHex(item.id)}` : <><Num text={amount.text} /> {amount.symbol}</>}
          sub={
            <>
              <RouteIcons from={item.sourceChainId} to={item.destinationChainId} names={names} />
              {item.sentAt === null ? null : <span>{relativeTime(item.sentAt, now)}</span>}
            </>
          }
          status={statusWord(item.status)}
        />
      );
    });
  }
  if (fetched.kind === "proofs") {
    return fetched.page.items.map((proof) => (
      <XRow
        key={`${proof.chainId}-${proof.slot}`}
        href={explore({ kind: "proof", chainId: proof.chainId, id: String(proof.number) })}
        icon={<RouteIcons from={otherOf(proof.chainId)} to={proof.chainId} names={names} />}
        title={`Proof #${proof.number}`}
        sub={`slot ${proof.slot.toLocaleString("en-US")} · ${relativeTime(proof.timestamp, now)}`}
        status="posted"
      />
    ));
  }
  if (fetched.kind === "tokens") {
    return fetched.page.items.map((token) => (
      <XRow
        key={`${token.chainId}:${token.address}`}
        href={explore({ kind: "token", id: `${sideOf(token.chainId)}:${token.address}` })}
        icon={<TokenIcon subject={{ chainId: token.chainId, address: token.address }} badgeChainId={token.chainId} symbol={token.symbol ?? "?"} isBridgedCopy={token.isBridgedCopy} size={28} decorative />}
        title={token.symbol ?? shortHex(token.address)}
        sub={`${names(token.chainId)} · ${token.isBridgedCopy ? "bridged copy" : "native"} · ${token.transfers.toLocaleString("en-US")} ${token.transfers === 1 ? "transfer" : "transfers"}`}
      />
    ));
  }
  return fetched.page.items.map((item) => {
    const did = [item.sent > 0 ? `${item.sent.toLocaleString("en-US")} sent` : null, item.received > 0 ? `${item.received.toLocaleString("en-US")} received` : null, item.posted > 0 ? `${item.posted.toLocaleString("en-US")} proofs posted` : null].filter((part) => part !== null);
    return <XRow key={item.address} href={explore({ kind: "address", id: item.address })} title={<span className="zb-mono">{shortHex(item.address)}</span>} sub={`${did.join(" · ")}${item.lastActive === null ? "" : ` · last ${relativeTime(item.lastActive, now)}`}`} />;
  });
};

const range = (page: number, shown: number, total: number): string => `${((page - 1) * BROWSE_PAGE_SIZE + 1).toLocaleString("en-US")}–${((page - 1) * BROWSE_PAGE_SIZE + shown).toLocaleString("en-US")} of ${total.toLocaleString("en-US")}`;

const Pager = ({ kind, state, pages }: { readonly kind: ListKind; readonly state: ListState; readonly pages: number }) => {
  const link = (label: string, page: number, enabled: boolean) =>
    enabled ? (
      <a className="zb-pill" href={href(kind, withPage(state, page))}>
        {label}
      </a>
    ) : (
      <span className="zb-pill" aria-disabled="true">
        {label}
      </span>
    );
  return (
    <nav className="zb-bpager" aria-label="Pages">
      {link("First", 1, state.page > 1)}
      {link("Previous", state.page - 1, state.page > 1)}
      <span className="zb-bpage" aria-current="page">
        Page {state.page.toLocaleString("en-US")} of {pages.toLocaleString("en-US")}
      </span>
      {link("Next", state.page + 1, state.page < pages)}
      {link("Last", pages, state.page < pages)}
    </nav>
  );
};

/** One paged list: header with the total, filters, sort, the rows, and the pages. */
export const BrowseList = ({ kind, query }: { readonly kind: ListKind; readonly query: string | undefined }) => {
  const { pair, explore: source, now } = useServices();
  const state = parseListState(kind, query);
  const tokens = useTokens(pair.id).data ?? [];
  const snapshots = useRef(new Map<string, number>());
  const view = viewKey(kind, state);
  const result = useQuery({
    queryKey: ["explore", "browse", pair.id, kind, formatListState(kind, state)],
    queryFn: async () => {
      const fetched = await fetchPage(source.browse, kind, requestOf(kind, state, pair, Math.floor(now()), snapshots.current.get(view)));
      if (!snapshots.current.has(view)) snapshots.current.set(view, fetched.page.asOf);
      return fetched;
    },
    placeholderData: keepPreviousData,
    retry: 1,
  });
  const filtered = Object.keys(state.filters).length > 0;
  const fetched = result.data;
  const total = fetched?.page.total ?? null;
  const pages = total === null ? 1 : pageCount(total);
  const change = (next: ListState): void => go(href(kind, next));
  const refresh = (): void => {
    snapshots.current.delete(view);
    void result.refetch();
  };
  const pastTheEnd = total !== null && total > 0 && state.page > pages;
  return (
    <div className="zb-col zb-xpage">
      <XGroup title={TITLES[kind]} right={total === null ? "…" : `${total.toLocaleString("en-US")} ${filtered ? "match" : "in total"}`} />
      <div className="zb-bbar" role="group" aria-label="Filters and sort">
        {controlsOf(kind, state, pair, tokens, change)}
        <Menu label="Sort" value={state.sort} options={sortOptionsOf(kind, state)} onChange={(value) => change(withSort(state, value))} />
        {filtered ? (
          <button type="button" className="zb-pill" onClick={() => change({ ...state, filters: {}, page: 1 })}>
            Clear filters
          </button>
        ) : null}
      </div>
      {fetched === undefined && result.isError ? (
        <p className="zb-small" role="alert">
          The indexer did not answer ({result.error instanceof Error ? result.error.message : "unknown error"}). Your filters are kept.{" "}
          <button type="button" className="zb-pill" onClick={refresh}>
            Try again
          </button>
        </p>
      ) : fetched === undefined ? (
        <p className="zb-small" role="status" aria-busy="true">
          Loading {NOUNS[kind]}…
        </p>
      ) : (
        <>
          <p className="zb-small zb-bnote" role="status">
            {total === 0 ? "" : `${range(state.page, fetched.page.items.length, fetched.page.total)} · `}as of {relativeTime(fetched.page.asOf, now())}. Rows that arrive later join when you{" "}
            <button type="button" className="zb-link" onClick={refresh}>
              refresh
            </button>
            .{result.isError ? " The last refresh failed; these rows are from the last answer." : ""}
          </p>
          {pastTheEnd ? (
            <p className="zb-small">
              Page {state.page.toLocaleString("en-US")} is past the end: these filters match {total.toLocaleString("en-US")} {NOUNS[kind]}, {pages.toLocaleString("en-US")} {pages === 1 ? "page" : "pages"}.{" "}
              <a className="zb-link" href={href(kind, withPage(state, pages))}>
                Go to the last page
              </a>
            </p>
          ) : total === 0 ? (
            <p className="zb-small">
              {filtered ? (
                <>
                  No {NOUNS[kind]} match these filters. Change a filter or{" "}
                  <button type="button" className="zb-link" onClick={() => change({ ...state, filters: {}, page: 1 })}>
                    clear them
                  </button>
                  .
                </>
              ) : (
                `No ${NOUNS[kind]} on this pair yet. They appear here as the indexer reads them from the chains.`
              )}
            </p>
          ) : (
            <div aria-busy={result.isFetching && result.isPlaceholderData}>{rowsOf(fetched, pair, now())}</div>
          )}
          {total !== null && total > BROWSE_PAGE_SIZE ? <Pager kind={kind} state={state} pages={pages} /> : null}
        </>
      )}
    </div>
  );
};
