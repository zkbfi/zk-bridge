/**
 * The model of the command palette: what a result is, how local lists rank against a typed query, how results group,
 * and how the arrow keys move. Everything here is pure, so each rule has a unit test. The reads of the indexer for
 * identifiers and addresses live in `identifier-search.ts`.
 */
import type { Address, Hex } from "viem";
import type { PairConfig, TokenInfo } from "@terminal/model/types";
import {
  ZKB_SITES,
  crossLinks,
  type LinkContext,
  type SearchChain,
  type SearchLink,
  type SearchResult as CrossResult,
  type SearchSites,
} from "@zk-bridge/shared";
import type { DocEntry } from "../docs/doc-entries";
import type { Route } from "../app/route";

/** What a result is. The order of this list is the order of the groups. */
export const RESULT_KINDS = ["transfer", "transaction", "address", "token", "proof", "slot", "block", "release", "pair", "view", "action", "doc"] as const;

/** One kind of result. */
export type ResultKind = (typeof RESULT_KINDS)[number];

/** The title of each group. */
export const GROUP_TITLES: Readonly<Record<ResultKind | "recent", string>> = {
  recent: "Recent",
  transfer: "Transfers and messages",
  transaction: "Transactions",
  address: "Addresses",
  token: "Tokens",
  proof: "Proofs",
  slot: "Beacon slots",
  block: "Blocks",
  release: "Releases",
  pair: "Pairs",
  view: "Views",
  action: "Actions",
  doc: "Docs",
};

/** The theme choices. */
export type ThemeChoice = "light" | "dark" | "system" | "mono";

/** An action that the palette starts. */
export type ActionId =
  | { readonly name: "bridge" }
  | { readonly name: "wrap" }
  | { readonly name: "send-message" }
  | { readonly name: "connect-wallet" }
  | { readonly name: "disconnect-wallet" }
  | { readonly name: "switch-chain"; readonly chainId: number }
  | { readonly name: "settings" }
  | { readonly name: "theme"; readonly theme: ThemeChoice };

/** Where a result leads. */
export type Jump = { readonly type: "route"; readonly route: Route } | { readonly type: "action"; readonly action: ActionId };

/** One line of the palette. */
export type SearchResult = {
  /** Unique and stable, so the recent list can store it. */
  readonly id: string;
  readonly kind: ResultKind;
  readonly title: string;
  readonly subtitle: string;
  /** Extra words that a query can match, for example an address. */
  readonly keywords: readonly string[];
  readonly jump: Jump;
  /** The same thing on the other surfaces: the indexer, the status page, the backend, the block explorers. */
  readonly links?: readonly SearchLink[];
};

/** A group of results under one title. */
export type ResultGroup = {
  readonly id: ResultKind | "recent";
  readonly title: string;
  readonly results: readonly SearchResult[];
};

/** The views that the palette lists. The route of the pair view takes the default pair. */
export const viewResults = (defaultPairId: string): readonly SearchResult[] => [
  { id: "view:activity", kind: "view", title: "Activity", subtitle: "Your transfers: in flight and delivered", keywords: ["history", "transfers", "mine", "status", "progress"], jump: { type: "route", route: { name: "activity" } } },
  { id: "view:bridge", kind: "view", title: "Bridge", subtitle: "Send to the other chain", keywords: ["home", "send", "swap", defaultPairId], jump: { type: "route", route: { name: "bridge", pairId: defaultPairId, dir: "first-to-second" } } },
  { id: "view:explore", kind: "view", title: "Explore", subtitle: "Pairs, light clients, the prover, the indexer", keywords: ["explorer", "pairs", "health", "indexer"], jump: { type: "route", route: { name: "explore" } } },
  { id: "view:global", kind: "view", title: "Global view", subtitle: "Choose a pair and see its health", keywords: ["home", "pairs", "overview"], jump: { type: "route", route: { name: "global" } } },
  { id: "view:pair", kind: "view", title: "Pair view", subtitle: "Actions, feed and light client heads", keywords: ["dashboard", "feed", "transfers", defaultPairId], jump: { type: "route", route: { name: "pair", pairId: defaultPairId, token: null } } },
  { id: "view:audit", kind: "view", title: "Audit", subtitle: "Escrow against bridged supply, and fees", keywords: ["escrow", "supply", "mismatch", "fees"], jump: { type: "route", route: { name: "audit" } } },
  { id: "view:prover", kind: "view", title: "Prover and costs", subtitle: "Light client updates recorded on chain", keywords: ["updates", "gas", "poster", "costs", "proof"], jump: { type: "route", route: { name: "prover" } } },
  { id: "view:settings", kind: "view", title: "Connections: indexer and RPC URLs", subtitle: "Set the indexer and the RPC URL of each chain", keywords: ["endpoint", "rpc", "indexer", "fallback", "url", "connection"], jump: { type: "route", route: { name: "settings" } } },
  { id: "view:docs", kind: "view", title: "Docs", subtitle: "How to use the bridge", keywords: ["help", "guide", "documentation"], jump: { type: "route", route: { name: "docs", slug: null, heading: null } } },
];

/** The pairs that the page knows. */
export const pairResults = (pairs: readonly { readonly id: string; readonly label: string }[]): readonly SearchResult[] =>
  pairs.map((pair) => ({
    id: `pair:${pair.id}`,
    kind: "pair",
    title: pair.id,
    subtitle: pair.label,
    keywords: [pair.label],
    jump: { type: "route", route: { name: "pair", pairId: pair.id, token: null } },
  }));

/** The tokens of both chains, found by symbol or address. A token opens the pair view with the feed filtered to it. */
export const tokenResults = (tokens: readonly TokenInfo[], pair: PairConfig, context: LinkContext | null = null): readonly SearchResult[] =>
  tokens.map((token) => {
    const chain = token.side === "first" ? pair.first : pair.second;
    return {
      id: `token:${chain.chainId}:${token.address.toLowerCase()}`,
      kind: "token",
      title: token.symbol,
      subtitle: `${chain.name} · ${token.address}`,
      keywords: [token.address, chain.name],
      jump: { type: "route", route: { name: "pair", pairId: pair.id, token: token.address } },
      ...(context === null ? {} : { links: crossLinks({ type: "token", side: token.side, chainId: chain.chainId, address: token.address.toLowerCase() }, context) }),
    };
  });

/** The actions. Wallet and chain actions depend on whether a wallet is connected. */
export const actionResults = (input: { readonly pair: PairConfig; readonly walletConnected: boolean }): readonly SearchResult[] => {
  const action = (name: string, title: string, subtitle: string, keywords: readonly string[], id: ActionId): SearchResult => ({
    id: `action:${name}`,
    kind: "action",
    title,
    subtitle,
    keywords,
    jump: { type: "action", action: id },
  });
  const chains = [input.pair.first, input.pair.second];
  return [
    action("bridge", "Bridge tokens", "relayTokens or relayTokensAndCall, with an optional gas limit", ["send", "relay", "transfer", "deposit"], { name: "bridge" }),
    action("wrap", "Wrap the native coin", "Wrap and relay through the router", ["wrap", "native", "eth", "pls", "weth", "wpls"], { name: "wrap" }),
    action("send-message", "Send a message", "Call a contract on the other chain", ["message", "call", "requireToPassMessage"], { name: "send-message" }),
    input.walletConnected
      ? action("disconnect-wallet", "Disconnect the wallet", "Forget the connected account", ["wallet", "account", "sign out", "switch account"], { name: "disconnect-wallet" })
      : action("connect-wallet", "Connect a wallet", "Use the wallet in your browser, including a hardware wallet behind it", ["wallet", "account", "metamask", "ledger", "trezor"], { name: "connect-wallet" }),
    ...chains.map((chain) =>
      action(`switch-chain:${chain.chainId}`, `Switch the wallet to ${chain.name}`, `Chain ${chain.chainId}`, ["network", "chain", chain.name], { name: "switch-chain", chainId: chain.chainId }),
    ),
    action("settings", "Settings", "Configuration of this page", ["configuration", "indexer", "endpoint", "recent"], { name: "settings" }),
    action("theme:light", "Theme: light", "Use the light colors", ["appearance", "color", "mode"], { name: "theme", theme: "light" }),
    action("theme:dark", "Theme: dark", "Use the dark colors", ["appearance", "color", "mode"], { name: "theme", theme: "dark" }),
    action("theme:system", "Theme: follow the system", "Use the setting of your system", ["appearance", "color", "mode"], { name: "theme", theme: "system" }),
    action("theme:mono", "Theme: mono", "High contrast: off-white on black, colour only on things in motion", ["appearance", "color", "mode", "contrast", "accessibility"], { name: "theme", theme: "mono" }),
  ];
};

/** One result for the page and one for each heading of each documentation page, so a heading is a search target. */
export const docResults = (pages: readonly DocEntry[]): readonly SearchResult[] =>
  pages.flatMap((page) => [
    { id: `doc:${page.slug}`, kind: "doc" as const, title: page.title, subtitle: "Docs", keywords: [], jump: { type: "route" as const, route: { name: "docs" as const, slug: page.slug, heading: null } } },
    ...page.headings.map((heading) => ({
      id: `doc:${page.slug}:${heading.id}`,
      kind: "doc" as const,
      title: heading.text,
      subtitle: `Docs · ${page.title}`,
      keywords: [page.title],
      jump: { type: "route" as const, route: { name: "docs" as const, slug: page.slug, heading: heading.id } },
    })),
  ]);

/** One result for a message that the indexer knows. */
export const transferResult = (input: { readonly messageId: Hex; readonly subtitle: string }): SearchResult => ({
  id: `transfer:${input.messageId}`,
  kind: "transfer",
  title: `${input.messageId.slice(0, 10)}…${input.messageId.slice(-6)}`,
  subtitle: input.subtitle,
  keywords: [input.messageId],
  jump: { type: "route", route: { name: "message", messageId: input.messageId } },
});

/** One result for an address. */
export const addressResult = (address: Address): SearchResult => ({
  id: `address:${address.toLowerCase()}`,
  kind: "address",
  title: address,
  subtitle: "Its transfers and balances",
  keywords: [address],
  jump: { type: "route", route: { name: "address", address } },
});

/** The hosts that the links of a result lead to. The dapp's own links are relative, so they open in this page. */
export const PALETTE_SITES: SearchSites = { ...ZKB_SITES, dapp: "" };

/** The chains of the pair, as the search knows them. */
export const searchChainsOf = (pair: PairConfig): readonly SearchChain[] =>
  [pair.first, pair.second].map((chain) => ({
    chainId: chain.chainId,
    name: chain.name,
    side: chain.side,
    contracts: {
      bridge: chain.contracts.messageBridge,
      mediator: chain.contracts.tokenMediator,
      lightClient: chain.contracts.lightClient,
      wrappedNative: chain.contracts.wrappedNative,
      gate: chain.contracts.gate,
      deliveryRouter: chain.contracts.deliveryRouter,
    },
  }));

/** What the links of a result need: the hosts and the chains of the pair. */
export const linkContextOf = (pair: PairConfig): LinkContext => ({ sites: PALETTE_SITES, chains: searchChainsOf(pair) });

const exploreRoute = (page: Extract<Route, { name: "explore" }>["page"]): Jump => ({ type: "route", route: { name: "explore", page } });

/**
 * The palette line for a result of the shared search. The line opens the page of the dapp that the result names; its
 * `links` carry the other surfaces.
 *
 * @param result A result of `resolve`.
 */
export const crossResult = (result: CrossResult): SearchResult => {
  const { target } = result;
  const common = { title: result.title, subtitle: result.subtitle, keywords: [result.id], links: result.links };
  switch (target.type) {
    case "message":
      return { ...common, id: `transfer:${target.messageId}`, kind: "transfer", keywords: [target.messageId], jump: { type: "route", route: { name: "message", messageId: target.messageId as Hex } } };
    case "transaction":
      return { ...common, id: result.id, kind: "transaction", jump: exploreRoute({ kind: "tx", chainId: target.chainId, id: target.hash }) };
    case "address":
      return {
        ...common,
        id: result.id,
        kind: "address",
        jump: target.role !== null && target.role !== undefined && target.chainId !== null && target.chainId !== undefined ? exploreRoute({ kind: "contract", chainId: target.chainId, id: target.address }) : { type: "route", route: { name: "address", address: target.address as Address } },
      };
    case "token":
      return { ...common, id: result.id, kind: "token", jump: exploreRoute({ kind: "token", id: `${target.side}:${target.address}` }) };
    case "slot":
      return { ...common, id: result.id, kind: "slot", jump: exploreRoute({ kind: "slot", id: target.slot }) };
    case "block":
      return { ...common, id: result.id, kind: "block", jump: exploreRoute({ kind: "block", chainId: target.chainId, id: target.number }) };
    case "proof":
      return { ...common, id: result.id, kind: "proof", jump: exploreRoute({ kind: "proof", chainId: target.chainId, id: target.index }) };
    case "release":
      return { ...common, id: result.id, kind: "release", jump: exploreRoute({ kind: "release", id: target.cid }) };
  }
};

const words = (text: string): readonly string[] => text.toLowerCase().split(/[^a-z0-9_.]+/).filter((word) => word !== "");

const scoreWord = (queryWord: string, result: SearchResult): number => {
  const title = result.title.toLowerCase();
  if (title === queryWord) return 100;
  if (title.startsWith(queryWord)) return 80;
  if (words(result.title).some((word) => word.startsWith(queryWord))) return 60;
  if (title.includes(queryWord)) return 40;
  if (result.keywords.some((keyword) => keyword.toLowerCase().includes(queryWord))) return 25;
  if (result.subtitle.toLowerCase().includes(queryWord)) return 15;
  return 0;
};

/**
 * Ranks local results against a query. Every word of the query must match somewhere in a result. A match in the title
 * beats a match in the keywords, which beats a match in the subtitle. Equal scores keep the order of the list.
 *
 * @param query The text in the search field.
 * @param results The local results.
 */
export const rankResults = (query: string, results: readonly SearchResult[]): readonly SearchResult[] => {
  const queryWords = words(query);
  if (queryWords.length === 0) return [];
  return results
    .map((result, position) => {
      const scores = queryWords.map((word) => scoreWord(word, result));
      return { result, position, score: scores.includes(0) ? 0 : scores.reduce((sum, score) => sum + score, 0) };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.position - right.position)
    .map((entry) => entry.result);
};

/** The most results shown per group. Docs show more, because headings are many. */
const GROUP_LIMITS: Readonly<Record<ResultKind | "recent", number>> = {
  recent: 6,
  transfer: 5,
  transaction: 4,
  address: 6,
  token: 6,
  proof: 4,
  slot: 2,
  block: 4,
  release: 2,
  pair: 4,
  view: 10,
  action: 6,
  doc: 8,
};

/**
 * Groups results by kind in the fixed order of {@link RESULT_KINDS}, and drops empty groups.
 *
 * @param results Results in rank order.
 */
export const groupResults = (results: readonly SearchResult[]): readonly ResultGroup[] =>
  RESULT_KINDS.flatMap((kind): ResultGroup[] => {
    const matching = results.filter((result) => result.kind === kind).slice(0, GROUP_LIMITS[kind]);
    return matching.length === 0 ? [] : [{ id: kind, title: GROUP_TITLES[kind], results: matching }];
  });

/**
 * The groups for an empty query: the recent results first, then the views and the actions.
 *
 * @param recent The results that the user opened lately.
 * @param suggestions The views and actions to offer.
 */
export const emptyQueryGroups = (recent: readonly SearchResult[], suggestions: readonly SearchResult[]): readonly ResultGroup[] => {
  const recentGroup: ResultGroup[] = recent.length === 0 ? [] : [{ id: "recent", title: GROUP_TITLES.recent, results: recent.slice(0, GROUP_LIMITS.recent) }];
  const recentIds = new Set(recent.map((result) => result.id));
  return [...recentGroup, ...groupResults(suggestions.filter((result) => !recentIds.has(result.id)))];
};

/**
 * The results in the order that the arrow keys walk them.
 *
 * @param groups The groups.
 */
export const flattenGroups = (groups: readonly ResultGroup[]): readonly SearchResult[] => groups.flatMap((group) => group.results);

/** A key that moves the highlight. */
export type MoveKey = "ArrowDown" | "ArrowUp" | "Home" | "End";

/**
 * Moves the highlight. Down at the end wraps to the start, and up at the start wraps to the end.
 *
 * @param current The index now, or -1 for none.
 * @param count How many results there are.
 * @param key The key.
 * @returns The new index, or -1 when there are no results.
 */
export const moveHighlight = (current: number, count: number, key: MoveKey): number => {
  if (count === 0) return -1;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  if (key === "ArrowDown") return current < 0 || current >= count - 1 ? 0 : current + 1;
  return current <= 0 ? count - 1 : current - 1;
};
