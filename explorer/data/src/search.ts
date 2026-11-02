/**
 * Cross-referenced search. One resolver for every surface of zkb.fi: the dapp's palette, the indexer's search route and
 * the indexer's page. `resolve` classifies the text (`classifyQuery` of `@zkb/core`), asks the readers that the caller
 * injects, and returns typed results. Each result carries a link to every surface that shows the same thing: the dapp's
 * Explore, the indexer's page, the status page, the backend's JSON and the block explorers of the chain.
 *
 * Nothing here reads a network by itself, so the module is browser and Node safe and every rule is a unit test. A reader
 * that fails is reported in `problems`; the other readers still answer. The site addresses are link targets, not
 * connections: the caller passes them (`ZKB_SITES` holds the public ones).
 */
import { CANDIDATE_CLASS, classifyQuery, type QueryCandidate } from "@zkb/core";
import { chainNameOf, explorerLinks } from "./chain-metadata.js";
import type { Pair } from "./pairs.js";

/** The surfaces that a result links to. */
export const SEARCH_SURFACES = ["dapp", "indexer", "status", "backend", "gateway", "explorer"] as const;

/** One surface. */
export type SearchSurface = (typeof SEARCH_SURFACES)[number];

/** One link of a result. */
export type SearchLink = { readonly surface: SearchSurface; readonly label: string; readonly url: string };

/**
 * The bases of the surfaces, without a trailing slash. An empty string makes a link relative to the page that shows it
 * (the dapp's own links are `#/explore/...`). A missing or null base leaves that surface out.
 */
export type SearchSites = {
  readonly dapp?: string | null;
  readonly indexer?: string | null;
  readonly status?: string | null;
  readonly backend?: string | null;
  readonly gateway?: string | null;
};

/** The public hosts of zkb.fi. */
export const ZKB_SITES: Required<SearchSites> = {
  dapp: "https://next.zkb.fi",
  indexer: "https://indexer.zkb.fi",
  status: "https://status.zkb.fi",
  backend: "https://prove.zkb.fi",
  gateway: "https://gateway.zkb.fi",
};

/** The hosts that serve the dapp: the next channel, the main channel and the IPFS gateway. */
export const DAPP_ORIGINS = { next: "https://next.zkb.fi", main: "https://zkb.fi", gateway: "https://gateway.zkb.fi" } as const;

/** A contract of the deployment, by the key of `SideContracts`. */
export type SearchContractRole = "bridge" | "mediator" | "tokenFactory" | "wrappedNative" | "gate" | "lightClient" | "deliveryRouter" | "forkRegistry";

/** What each contract role is called. */
export const CONTRACT_ROLE_NAMES: Readonly<Record<SearchContractRole, string>> = {
  bridge: "MessageBridge",
  mediator: "ERC-20 mediator",
  tokenFactory: "Token factory",
  wrappedNative: "Wrapped native",
  gate: "Gate",
  lightClient: "Light client",
  deliveryRouter: "DeliveryRouter",
  forkRegistry: "Fork registry",
};

/** One chain that the search knows. `side` is the place of the chain in the pair. */
export type SearchChain = {
  readonly chainId: number;
  readonly name: string;
  readonly side: "first" | "second";
  readonly contracts: Readonly<Partial<Record<SearchContractRole, string | null>>>;
};

/**
 * The chains of a pair, in the shape of the search.
 *
 * @param pair The pair.
 * @param names Names that replace the ones of the chain metadata, by chain id. A chain with neither is called by its side's name.
 */
export const searchChainsFromPair = (pair: Pair, names: Readonly<Record<number, string>> = {}): readonly SearchChain[] =>
  pair.sides.map((side, index) => ({
    chainId: side.chainId,
    name: names[side.chainId] ?? chainNameOf(side.chainId) ?? side.name,
    side: index === 0 ? "first" : "second",
    contracts: side.contracts,
  }));

/** The direction of the bridge that delivers to a chain: the chain's light client proves the other chain. */
export type SearchDirection = "first-to-second" | "second-to-first";

/** One thing the search can point at. Hex is lowercase; numbers are decimal text. */
export type SearchTarget =
  | { readonly type: "message"; readonly messageId: string; readonly direction?: SearchDirection | null }
  | { readonly type: "transaction"; readonly chainId: number; readonly hash: string }
  | { readonly type: "address"; readonly address: string; readonly chainId?: number | null; readonly role?: SearchContractRole | null }
  | { readonly type: "token"; readonly side: "first" | "second"; readonly chainId: number; readonly address: string }
  | { readonly type: "slot"; readonly slot: string }
  | { readonly type: "block"; readonly chainId: number; readonly number: string }
  | { readonly type: "proof"; readonly chainId: number; readonly index: string }
  | { readonly type: "release"; readonly cid: string };

/** What the links need to know. */
export type LinkContext = { readonly sites: SearchSites; readonly chains: readonly SearchChain[] };

const at = (base: string | null | undefined, path: string): string | null => {
  if (base === null || base === undefined) return null;
  return base === "" ? path.replace(/^\//, "") : `${base.replace(/\/+$/, "")}${path}`;
};

/** The direction that a chain's light client serves (it delivers to that chain), or null for a chain outside the pair. */
export const directionTo = (chains: readonly SearchChain[], chainId: number): SearchDirection | null => {
  const side = chains.find((chain) => chain.chainId === chainId)?.side;
  return side === undefined ? null : side === "second" ? "first-to-second" : "second-to-first";
};

const directionFrom = (chains: readonly SearchChain[], chainId: number): SearchDirection | null => {
  const side = chains.find((chain) => chain.chainId === chainId)?.side;
  return side === undefined ? null : side === "first" ? "first-to-second" : "second-to-first";
};

/**
 * The query that the indexer's page takes in its `#lookup=` anchor, and that the search route answers: the thing as a
 * person types it.
 *
 * @param target The thing.
 */
export const lookupTextOf = (target: SearchTarget): string => {
  switch (target.type) {
    case "message":
      return target.messageId;
    case "transaction":
      return target.hash;
    case "address":
    case "token":
      return target.address;
    case "slot":
      return target.slot;
    case "block":
      return target.number;
    case "proof":
      return target.index;
    case "release":
      return target.cid;
  }
};

const dappPath = (target: SearchTarget): string => {
  switch (target.type) {
    case "message":
      return `/message/${target.messageId}`;
    case "transaction":
      return `/explore/tx/${target.chainId}/${target.hash}`;
    case "address":
      return target.role !== null && target.role !== undefined && target.chainId !== null && target.chainId !== undefined
        ? `/explore/contract/${target.chainId}/${target.address}`
        : `/explore/address/${target.address}`;
    case "token":
      return `/explore/token/${target.side}/${target.address}`;
    case "slot":
      return `/explore/slot/${target.slot}`;
    case "block":
      return `/explore/block/${target.chainId}/${target.number}`;
    case "proof":
      return `/explore/proof/${target.chainId}/${target.index}`;
    case "release":
      return `/explore/release/${target.cid}`;
  }
};

/** The checks of the status page that are about the target: an id and a label for when there are several. */
const statusChecks = (target: SearchTarget, chains: readonly SearchChain[]): readonly { readonly id: string; readonly label: string }[] => {
  const named = (chainId: number, prefix: string, name: string) => ({ id: `${prefix}-${chainId}`, label: name });
  const nameOf = (chainId: number): string => chains.find((chain) => chain.chainId === chainId)?.name ?? `chain ${chainId}`;
  switch (target.type) {
    case "message":
      return [{ id: target.direction === null || target.direction === undefined ? "pipeline-deliveries" : `pipeline-${target.direction}`, label: "pipeline" }];
    case "transaction":
    case "block":
      return [named(target.chainId, "rpc", nameOf(target.chainId))];
    case "address": {
      if (target.chainId === null || target.chainId === undefined) return [];
      if (target.role === "bridge") return [named(target.chainId, "bridge", nameOf(target.chainId))];
      if (target.role === "gate") return [named(target.chainId, "gate", nameOf(target.chainId))];
      if (target.role === "lightClient") {
        const direction = directionTo(chains, target.chainId);
        return direction === null ? [] : [{ id: `lightclient-${direction}`, label: nameOf(target.chainId) }];
      }
      return [];
    }
    case "token":
      return [];
    case "slot":
      return chains.map((chain) => named(chain.chainId, "beacon", chain.name));
    case "proof": {
      const direction = directionTo(chains, target.chainId);
      return direction === null ? [] : [{ id: `lightclient-${direction}`, label: nameOf(target.chainId) }];
    }
    case "release":
      return [{ id: "gateway-next", label: "gateway" }];
  }
};

/**
 * The links of a target to every surface that shows it, in a fixed order: the dapp, the indexer, the status page, the
 * backend, the IPFS gateway, then one link per block explorer of the chain (an address on no known chain links to the
 * explorers of every chain).
 *
 * @param target The thing.
 * @param context The sites and the chains.
 */
export const crossLinks = (target: SearchTarget, context: LinkContext): readonly SearchLink[] => {
  const { sites, chains } = context;
  const links: SearchLink[] = [];
  const add = (surface: SearchSurface, label: string, url: string | null): void => {
    if (url !== null) links.push({ surface, label, url });
  };
  add("dapp", "Open in Explore", at(sites.dapp, `/#${dappPath(target)}`));
  add("indexer", "Indexer", at(sites.indexer, `/#lookup=${encodeURIComponent(lookupTextOf(target))}`));
  const checks = statusChecks(target, chains);
  for (const check of checks) add("status", checks.length === 1 ? "Status" : `Status · ${check.label}`, at(sites.status, `/#check=${check.id}`));
  if (target.type === "message") add("backend", "Backend JSON", at(sites.backend, `/progress/${target.messageId}`));
  if (target.type === "proof") {
    const direction = directionTo(chains, target.chainId);
    if (direction !== null) add("backend", "Backend JSON", at(sites.backend, `/directions/${direction}/pipeline`));
  }
  if (target.type === "release") add("gateway", "IPFS gateway", at(sites.gateway, `/ipfs/${target.cid}`));
  const explorers = (chainId: number, kind: "tx" | "block" | "address", id: string): void => {
    for (const link of explorerLinks(chainId, kind, id)) links.push({ surface: "explorer", label: link.name, url: link.url });
  };
  if (target.type === "transaction") explorers(target.chainId, "tx", target.hash);
  if (target.type === "block") explorers(target.chainId, "block", target.number);
  if (target.type === "token") explorers(target.chainId, "address", target.address);
  if (target.type === "address") {
    for (const chain of chains) if (target.chainId === null || target.chainId === undefined || target.chainId === chain.chainId) explorers(chain.chainId, "address", target.address);
  }
  return links;
};

/** The kinds of result. */
export const SEARCH_RESULT_KINDS = ["message", "transaction", "address", "token", "slot", "block", "proof", "release"] as const;

/** One kind of result. */
export type SearchResultKind = (typeof SEARCH_RESULT_KINDS)[number];

/** What an address is. */
export type SearchAddressType = "account" | "contract" | "unknown" | SearchContractRole;

/** One result. */
export type SearchResult = {
  /** Unique in a resolution and stable between runs. */
  readonly id: string;
  readonly kind: SearchResultKind;
  readonly title: string;
  readonly subtitle: string;
  /** True when a reader found the thing; false when only its shape fits (the page that it links to checks). */
  readonly confirmed: boolean;
  readonly chainId: number | null;
  /** For an address: what it is. */
  readonly addressType: SearchAddressType | null;
  readonly target: SearchTarget;
  readonly links: readonly SearchLink[];
  /** Lower is better. Class (exact id, address, prefix, symbol, number) first, then found before shaped, then order. */
  readonly rank: number;
};

/** One bridge message, as the indexer knows it. */
export type SearchMessage = {
  readonly messageId: string;
  readonly kind: "token" | "message";
  readonly status: string;
  readonly sourceChainId: number;
  readonly destinationChainId: number;
  readonly sentTransactionHash: string | null;
  readonly deliveredTransactionHash: string | null;
  readonly symbol: string | null;
};

/** One light client update, as the indexer knows it. */
export type SearchHeadUpdate = { readonly chainId: number; readonly slot: string; readonly transactionHash: string };

/** One bridged token, as the indexer knows it. */
export type SearchToken = { readonly chainId: number; readonly address: string; readonly symbol: string; readonly name: string | null };

/** One proof (a light client update with a number), as a page that loaded the proofs knows it. */
export type SearchProof = { readonly chainId: number; readonly number: string; readonly slot: string };

/** The readers of the resolver. Each is optional: a missing reader leaves its results shaped but not confirmed. */
export type SearchSources = {
  readonly sites: SearchSites;
  readonly chains: readonly SearchChain[];
  readonly indexer?: {
    readonly message: (messageId: string) => Promise<SearchMessage | null>;
    readonly messageByTransaction: (hash: string) => Promise<SearchMessage | null>;
    readonly headUpdateByTransaction?: (hash: string) => Promise<SearchHeadUpdate | null>;
    readonly headUpdatesBySlot?: (slot: string) => Promise<readonly SearchHeadUpdate[]>;
    readonly tokens?: () => Promise<readonly SearchToken[]>;
    readonly messagesByPrefix?: (prefix: string) => Promise<readonly SearchMessage[]>;
    readonly transferCount?: (address: string) => Promise<number>;
  };
  readonly chain?: {
    readonly transaction?: (chainId: number, hash: string) => Promise<boolean>;
    readonly block?: (chainId: number, number: string) => Promise<boolean>;
    readonly isContract?: (chainId: number, address: string) => Promise<boolean>;
  };
  readonly proofs?: { readonly matching: (value: string) => Promise<readonly SearchProof[]> };
  readonly backend?: { readonly progress: (messageId: string) => Promise<{ readonly service: string } | null> };
};

/** What {@link resolve} returns. */
export type SearchResolution = {
  readonly query: string;
  readonly candidates: readonly QueryCandidate[];
  /** Set when the text is a kind of name that is not resolved. */
  readonly unsupported: "name" | null;
  /** The results, best first. */
  readonly results: readonly SearchResult[];
  /** One fixed sentence ("<source>: unavailable") for each reader that failed. It never holds the error text. */
  readonly problems: readonly string[];
};

/** Binds the arguments of a reader that may be missing. */
const bound = <arguments_ extends unknown[], value>(reader: ((...arguments__: arguments_) => Promise<value>) | undefined, ...input: arguments_): (() => Promise<value>) | undefined =>
  reader === undefined ? undefined : () => reader(...input);

/** Options of {@link resolve}. */
export type ResolveOptions = {
  /** The most results returned. Default 25. */
  readonly limit?: number;
  /** Called with the source and the error of a reader that failed. `problems` never holds the error's text; log it here, redacted. */
  readonly onError?: (label: string, error: unknown) => void;
};

const DEFAULT_LIMIT = 25;
const PREFIX_LIMIT = 10;
const SYMBOL_LIMIT = 8;

const shortHash = (hash: string): string => `${hash.slice(0, 10)}…${hash.slice(-6)}`;
const grouped = (digits: string): string => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

type Draft = Omit<SearchResult, "links" | "rank"> & { readonly order: number; readonly klass: number };

/**
 * Resolves a search text into typed results with cross-links.
 *
 * @param text The text in a search field.
 * @param sources The sites, the chains and the readers.
 * @param options The limit.
 */
export async function resolve(text: string, sources: SearchSources, options: ResolveOptions = {}): Promise<SearchResolution> {
  const classification = classifyQuery(text);
  const { chains } = sources;
  const problems: string[] = [];
  const context: LinkContext = { sites: sources.sites, chains };
  const chainName = (chainId: number): string => chains.find((chain) => chain.chainId === chainId)?.name ?? `chain ${chainId}`;
  const sideOf = (chainId: number): "first" | "second" => chains.find((chain) => chain.chainId === chainId)?.side ?? "first";

  /** Runs a reader; a failure becomes a problem and an undefined answer. */
  const attempt = async <value>(label: string, run: () => Promise<value>): Promise<value | undefined> => {
    try {
      return await run();
    } catch (error) {
      // The answer carries a fixed sentence: a reader's error can hold an internal URL or a key. The caller gets the error.
      problems.push(`${label}: unavailable`);
      options.onError?.(label, error);
      return undefined;
    }
  };

  /** Runs a reader that may be missing; a missing reader or a failed one gives the fallback. */
  const ask = async <value>(label: string, reader: (() => Promise<value>) | undefined, fallback: value): Promise<value> =>
    reader === undefined ? fallback : ((await attempt(label, reader)) ?? fallback);

  const draft = (klass: number, order: number, base: Omit<SearchResult, "links" | "rank">): Draft => ({ ...base, klass, order });

  const messageDraft = (message: SearchMessage, klass: number, order: number, foundBy: string, waiting: string | null): Draft => {
    const direction = directionFrom(chains, message.sourceChainId);
    return draft(klass, order, {
      id: `message:${message.messageId}`,
      kind: "message",
      title: shortHash(message.messageId),
      subtitle: `${message.kind === "token" ? "Transfer" : "Message"}${message.symbol === null ? "" : ` of ${message.symbol}`} · ${message.status.replace(/_/g, " ")} · ${chainName(message.sourceChainId)} to ${chainName(message.destinationChainId)} · found by ${foundBy}${waiting === null ? "" : ` · waiting on ${waiting}`}`,
      confirmed: true,
      chainId: message.sourceChainId,
      addressType: null,
      target: { type: "message", messageId: message.messageId, direction },
    });
  };

  const transactionDraft = (chainId: number, hash: string, subtitle: string, confirmed: boolean, order: number): Draft =>
    draft(0, order, {
      id: `transaction:${chainId}:${hash}`,
      kind: "transaction",
      title: `Transaction ${shortHash(hash)}`,
      subtitle,
      confirmed,
      chainId,
      addressType: null,
      target: { type: "transaction", chainId, hash },
    });

  const roleDrafts = (matches: (address: string) => boolean, klass: number, limit: number): Draft[] => {
    const found: Draft[] = [];
    for (const chain of chains) {
      for (const role of Object.keys(CONTRACT_ROLE_NAMES) as SearchContractRole[]) {
        const address = chain.contracts[role];
        if (address === null || address === undefined || !matches(address.toLowerCase())) continue;
        found.push(
          draft(klass, found.length, {
            id: `address:${chain.chainId}:${address.toLowerCase()}`,
            kind: "address",
            title: `${CONTRACT_ROLE_NAMES[role]} on ${chain.name}`,
            subtitle: address.toLowerCase(),
            confirmed: true,
            chainId: chain.chainId,
            addressType: role,
            target: { type: "address", address: address.toLowerCase(), chainId: chain.chainId, role },
          }),
        );
      }
    }
    return found.slice(0, limit);
  };

  const tokenDraft = (token: SearchToken, klass: number, order: number): Draft =>
    draft(klass, order, {
      id: `token:${token.chainId}:${token.address.toLowerCase()}`,
      kind: "token",
      title: token.symbol,
      subtitle: `${chainName(token.chainId)} · ${token.address.toLowerCase()}${token.name === null ? "" : ` · ${token.name}`}`,
      confirmed: true,
      chainId: token.chainId,
      addressType: null,
      target: { type: "token", side: sideOf(token.chainId), chainId: token.chainId, address: token.address.toLowerCase() },
    });

  const forCandidate = async (candidate: QueryCandidate): Promise<Draft[]> => {
    const indexer = sources.indexer;
    switch (candidate.kind) {
      case "message-id": {
        const message = await ask("indexer", bound(indexer?.message, candidate.hash), null);
        if (message === null) return [];
        const progress = await ask("backend", bound(sources.backend?.progress, candidate.hash), null);
        return [messageDraft(message, 0, 0, "identifier", progress === null || progress.service === "none" ? null : progress.service)];
      }
      case "transaction": {
        const found: Draft[] = [];
        const message = await ask("indexer", bound(indexer?.messageByTransaction, candidate.hash), null);
        if (message !== null) {
          found.push(messageDraft(message, 0, 1, "transaction", null));
          const sent = message.sentTransactionHash?.toLowerCase() === candidate.hash;
          found.push(transactionDraft(sent ? message.sourceChainId : message.destinationChainId, candidate.hash, `${sent ? "Send" : "Delivery"} of a ${message.kind === "token" ? "transfer" : "message"} · ${chainName(sent ? message.sourceChainId : message.destinationChainId)}`, true, 2));
        }
        const update = await ask("indexer", bound(indexer?.headUpdateByTransaction, candidate.hash), null);
        if (update !== null) found.push(transactionDraft(update.chainId, candidate.hash, `Light client update to slot ${grouped(update.slot)} · ${chainName(update.chainId)}`, true, 3));
        if (found.length > 0) return found;
        const reader = sources.chain?.transaction;
        return Promise.all(
          chains.map(async (chain, index) => {
            const exists = reader === undefined ? false : ((await attempt(`${chain.name} node`, () => reader(chain.chainId, candidate.hash))) ?? false);
            return transactionDraft(chain.chainId, candidate.hash, exists ? `On ${chain.name}` : `If it is on ${chain.name}`, exists, 10 + index);
          }),
        );
      }
      case "address": {
        const matched = roleDrafts((address) => address === candidate.address, 1, PREFIX_LIMIT);
        const tokens = await ask("indexer", bound(indexer?.tokens), []);
        const asTokens = tokens.filter((token) => token.address.toLowerCase() === candidate.address).map((token, index) => tokenDraft(token, 1, 10 + index));
        if (matched.length + asTokens.length > 0) return [...matched, ...asTokens];
        const contractReader = sources.chain?.isContract;
        const answers = contractReader === undefined ? [] : await Promise.all(chains.map((chain) => attempt(`${chain.name} node`, () => contractReader(chain.chainId, candidate.address))));
        const addressType: SearchAddressType = answers.includes(true) ? "contract" : answers.length > 0 && answers.every((answer) => answer === false) ? "account" : "unknown";
        const count = await ask<number | null>("indexer", bound(indexer?.transferCount, candidate.address), null);
        const typeText = addressType === "account" ? "Account" : addressType === "contract" ? "Contract" : "Address";
        return [
          draft(1, 0, {
            id: `address:${candidate.address}`,
            kind: "address",
            title: candidate.address,
            subtitle: `${typeText}${count === null ? "" : ` · ${count === 1 ? "1 transfer" : `${count} transfers`}`} · its transfers and balances`,
            confirmed: true,
            chainId: null,
            addressType,
            target: { type: "address", address: candidate.address, chainId: null, role: null },
          }),
        ];
      }
      case "hex-prefix": {
        const found = roleDrafts((address) => address.startsWith(candidate.prefix), 2, PREFIX_LIMIT);
        const tokens = await ask("indexer", bound(indexer?.tokens), []);
        found.push(...tokens.filter((token) => token.address.toLowerCase().startsWith(candidate.prefix)).slice(0, PREFIX_LIMIT).map((token, index) => tokenDraft(token, 2, 10 + index)));
        const messages = await ask("indexer", bound(indexer?.messagesByPrefix, candidate.prefix), []);
        found.push(...messages.slice(0, PREFIX_LIMIT).map((message, index) => messageDraft(message, 2, 20 + index, "identifier start", null)));
        return found;
      }
      case "symbol": {
        const tokens = await ask("indexer", bound(indexer?.tokens), []);
        const needle = candidate.text.toLowerCase();
        const tier = (token: SearchToken): number => {
          const symbol = token.symbol.toLowerCase();
          const name = (token.name ?? "").toLowerCase();
          if (symbol === needle || name === needle) return 0;
          if (symbol.startsWith(needle) || name.startsWith(needle)) return 1;
          return symbol.includes(needle) || name.includes(needle) ? 2 : 3;
        };
        return tokens
          .filter((token) => tier(token) < 3)
          .sort((a, b) => tier(a) - tier(b) || a.symbol.localeCompare(b.symbol) || a.chainId - b.chainId || a.address.localeCompare(b.address))
          .slice(0, SYMBOL_LIMIT)
          .map((token, index) => tokenDraft(token, 3, index));
      }
      case "slot": {
        const updates = await ask("indexer", bound(indexer?.headUpdatesBySlot, candidate.value), []);
        const first = updates[0];
        return [
          draft(4, 2, {
            id: `slot:${candidate.value}`,
            kind: "slot",
            title: `Slot ${grouped(candidate.value)}`,
            subtitle: first === undefined ? "Beacon chain" : `Beacon chain · light client update on ${chainName(first.chainId)}`,
            confirmed: first !== undefined,
            chainId: null,
            addressType: null,
            target: { type: "slot", slot: candidate.value },
          }),
        ];
      }
      case "block": {
        const reader = sources.chain?.block;
        return Promise.all(
          chains.map(async (chain, index) => {
            const exists = reader === undefined ? false : ((await attempt(`${chain.name} node`, () => reader(chain.chainId, candidate.value))) ?? false);
            return draft(4, 3 + index, {
              id: `block:${chain.chainId}:${candidate.value}`,
              kind: "block",
              title: `Block ${grouped(candidate.value)}`,
              subtitle: chain.name,
              confirmed: exists,
              chainId: chain.chainId,
              addressType: null,
              target: { type: "block", chainId: chain.chainId, number: candidate.value },
            });
          }),
        );
      }
      case "proof": {
        const proofDraft = (chainId: number, number: string, subtitle: string, confirmed: boolean, order: number): Draft =>
          draft(4, order, {
            id: `proof:${chainId}:${number}`,
            kind: "proof",
            title: `Proof #${number}`,
            subtitle,
            confirmed,
            chainId,
            addressType: null,
            target: { type: "proof", chainId, index: number },
          });
        if (sources.proofs === undefined) {
          return chains.filter((chain) => chain.contracts.lightClient !== null && chain.contracts.lightClient !== undefined).map((chain, index) => proofDraft(chain.chainId, candidate.value, `Light client update on ${chain.name}`, false, index));
        }
        const matching = (await attempt("proofs", () => (sources.proofs as NonNullable<SearchSources["proofs"]>).matching(candidate.value))) ?? [];
        return matching.map((proof, index) => proofDraft(proof.chainId, proof.number, `Slot ${grouped(proof.slot)} · light client update on ${chainName(proof.chainId)}`, true, index));
      }
      case "cid":
        return [
          draft(0, 0, {
            id: `release:${candidate.cid}`,
            kind: "release",
            title: "Release",
            subtitle: shortHash(candidate.cid),
            confirmed: false,
            chainId: null,
            addressType: null,
            target: { type: "release", cid: candidate.cid },
          }),
        ];
    }
  };

  const drafts = (await Promise.all(classification.candidates.map(async (candidate) => (await forCandidate(candidate)).map((entry) => ({ ...entry, klass: CANDIDATE_CLASS[candidate.kind] }))))).flat();

  // Keep the first draft of each id (a message found by its identifier and by its transaction is one result).
  const byId = new Map<string, Draft>();
  for (const entry of drafts) {
    if (!byId.has(entry.id)) byId.set(entry.id, entry);
  }
  let kept = [...byId.values()];
  // A hash that is a known message or transaction is not also a guess on every chain.
  if (kept.some((entry) => entry.klass === 0 && entry.confirmed)) kept = kept.filter((entry) => !(entry.kind === "transaction" && !entry.confirmed));

  const ranked: SearchResult[] = kept
    .map((entry): SearchResult => {
      const { order, klass, ...result } = entry;
      return { ...result, rank: klass * 100 + (entry.confirmed ? 0 : 50) + order, links: crossLinks(entry.target, context) };
    })
    .sort((a, b) => a.rank - b.rank); // The sort is stable, so equal ranks keep the order of the readings.

  return {
    query: classification.query,
    candidates: classification.candidates,
    unsupported: classification.unsupported,
    results: ranked.slice(0, options.limit ?? DEFAULT_LIMIT),
    problems,
  };
}

