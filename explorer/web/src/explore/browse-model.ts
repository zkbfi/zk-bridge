/**
 * The state of a browse list and its address. A list page keeps its filters, its sort and its page in the hash
 * (`#/explore/browse/transfers?status=inflight&sort=oldest&page=3`), so a link opens the same view and back and forward
 * walk the views. Only what differs from the defaults is written. This file is pure: it parses a query string, writes
 * one back, and turns the state into the request the indexer reads.
 */
import type { PairConfig } from "@terminal/model/types";
import { BROWSE_PAGE_SIZE, type BrowseRequest } from "@zk-bridge/shared";

/** The kinds that page: they have more rows than a screen holds. */
export const LIST_KINDS = ["transfers", "proofs", "tokens", "addresses"] as const;
export type ListKind = (typeof LIST_KINDS)[number];

/** Whether the browse kind is one of the paged lists. */
export const isListKind = (kind: string): kind is ListKind => (LIST_KINDS as readonly string[]).includes(kind);

/** A list's controls: the sorts (first is the default), the menus with their allowed values, and the text boxes. */
export type ListSpec = {
  readonly sorts: readonly string[];
  readonly menus: Readonly<Record<string, readonly string[]>>;
  readonly texts: readonly string[];
};

export const LIST_SPECS: Readonly<Record<ListKind, ListSpec>> = {
  transfers: {
    sorts: ["newest", "oldest", "amount-high", "amount-low"],
    menus: { from: ["first", "second"], status: ["inflight", "delivered", "failed"], kind: ["token", "message"], since: ["1h", "24h", "7d"], token: [] },
    texts: ["account"],
  },
  proofs: { sorts: ["newest", "oldest", "slot-high", "slot-low"], menus: { chain: ["first", "second"] }, texts: ["poster"] },
  tokens: { sorts: ["symbol", "transfers"], menus: { chain: ["first", "second"], kind: ["native", "copy"] }, texts: [] },
  addresses: { sorts: ["activity", "recent"], menus: { role: ["sender", "recipient", "poster"] }, texts: ["q"] },
};

/** The state of one list. `filters` holds only the filters that are set. */
export type ListState = { readonly filters: Readonly<Record<string, string>>; readonly sort: string; readonly page: number };

const TEXT_LIMIT = 66;
/** The address boxes take a whole address; the address list's own box takes any start of one. */
const TEXT_PATTERN = (key: string): RegExp => (key === "q" ? /^(0x)?[0-9a-fA-F]{1,40}$/ : /^0x[0-9a-fA-F]{40}$/);

/**
 * Reads the state from a query string. A value the list does not know is dropped, so an old or edited link opens the
 * list unfiltered instead of failing. The token menu takes any token address, because the tokens differ by pair.
 */
export const parseListState = (kind: ListKind, query: string | undefined): ListState => {
  const spec = LIST_SPECS[kind];
  const params = new URLSearchParams(query ?? "");
  const filters: Record<string, string> = {};
  for (const [key, allowed] of Object.entries(spec.menus)) {
    const value = params.get(key);
    if (value !== null && (key === "token" ? /^(first|second):0x[0-9a-fA-F]{40}$/.test(value) : allowed.includes(value))) filters[key] = value;
  }
  for (const key of spec.texts) {
    const value = params.get(key)?.trim() ?? "";
    if (value !== "" && value.length <= TEXT_LIMIT && TEXT_PATTERN(key).test(value)) filters[key] = value;
  }
  const sort = params.get("sort") ?? "";
  const page = Number(params.get("page"));
  return {
    filters,
    sort: spec.sorts.includes(sort) ? sort : (spec.sorts[0] as string),
    page: Number.isInteger(page) && page >= 1 ? page : 1,
  };
};

/** The query string of a state, without defaults and without `?`. Page 1 and the default sort are left out. */
export const formatListState = (kind: ListKind, state: ListState): string => {
  const spec = LIST_SPECS[kind];
  const params = new URLSearchParams();
  for (const key of [...Object.keys(spec.menus), ...spec.texts]) {
    const value = state.filters[key];
    if (value !== undefined) params.set(key, value);
  }
  if (state.sort !== spec.sorts[0]) params.set("sort", state.sort);
  if (state.page > 1) params.set("page", String(state.page));
  return params.toString();
};

/** The same filters and sort, on another page (page 1 for a changed filter or sort). */
export const withFilter = (state: ListState, key: string, value: string | null): ListState => {
  const { [key]: _removed, ...rest } = state.filters;
  return { ...state, filters: value === null || value === "" ? rest : { ...rest, [key]: value }, page: 1 };
};

/** The same filters on a new sort, from page 1. */
export const withSort = (state: ListState, sort: string): ListState => ({ ...state, sort, page: 1 });
export const withPage = (state: ListState, page: number): ListState => ({ ...state, page });

/** The number of pages for a total, at least 1 so an empty list reads "page 1 of 1". */
export const pageCount = (total: number, size: number = BROWSE_PAGE_SIZE): number => Math.max(1, Math.ceil(total / size));

/** The ordinary seconds of a `since` menu value. */
const SINCE_SECONDS: Readonly<Record<string, number>> = { "1h": 3600, "24h": 86_400, "7d": 7 * 86_400 };

const sideChain = (pair: PairConfig, side: string) => (side === "first" ? pair.first : pair.second);

/** `first:0x…` → the chain id and the address. */
const tokenOf = (pair: PairConfig, value: string): { chainId: number; address: string } => {
  const [side = "", address = ""] = value.split(":");
  return { chainId: sideChain(pair, side).chainId, address };
};

/** The statuses that a status menu value stands for. */
const STATUS_PARAM: Readonly<Record<string, string>> = { inflight: "inflight", delivered: "delivered", failed: "failed_call,release_failed" };

/**
 * The request for the state's page.
 *
 * @param kind The list.
 * @param state The state.
 * @param pair The pair, which turns `first` and `second` into chain ids.
 * @param now Unix seconds, for the `since` range.
 * @param asOf The snapshot of the first page of this view, or undefined for the first request.
 */
export const requestOf = (kind: ListKind, state: ListState, pair: PairConfig, now: number, asOf: number | undefined): BrowseRequest => {
  const { filters, sort, page } = state;
  const window = { limit: BROWSE_PAGE_SIZE, offset: (page - 1) * BROWSE_PAGE_SIZE, sort, asOf };
  if (kind === "transfers") {
    const source = filters.from === undefined ? undefined : sideChain(pair, filters.from);
    const destination = filters.from === undefined ? undefined : sideChain(pair, filters.from === "first" ? "second" : "first");
    const token = filters.token === undefined ? undefined : tokenOf(pair, filters.token).address;
    return {
      ...window,
      direction: source === undefined || destination === undefined ? undefined : `${source.chainId}>${destination.chainId}`,
      status: filters.status === undefined ? undefined : STATUS_PARAM[filters.status],
      kind: filters.kind,
      token,
      address: filters.account,
      from: filters.since === undefined ? undefined : now - (SINCE_SECONDS[filters.since] as number),
    };
  }
  if (kind === "proofs") return { ...window, chainId: filters.chain === undefined ? undefined : sideChain(pair, filters.chain).chainId, poster: filters.poster };
  if (kind === "tokens") return { ...window, chainId: filters.chain === undefined ? undefined : sideChain(pair, filters.chain).chainId, kind: filters.kind, asOf: undefined };
  return { ...window, role: filters.role, q: filters.q, asOf: undefined };
};

/**
 * The key of a view without its page: what changes the snapshot. A changed filter or sort starts a new snapshot; a
 * changed page keeps it.
 */
export const viewKey = (kind: ListKind, state: ListState): string => `${kind}?${formatListState(kind, { ...state, page: 1 })}`;
