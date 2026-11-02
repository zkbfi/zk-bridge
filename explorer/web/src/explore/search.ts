/**
 * Explore's search band (owner: "include more data including searches of the proofs or transactions or identifers"):
 * it recognises what was typed and searches what the page has loaded from the indexer and the deployment. Results come
 * grouped by kind; each carries the matched text so the page can underline it.
 */
import type { Address } from "viem";
import type { ChainConfig, FeedItem, PairConfig, TokenInfo } from "@terminal/model/types";
import { classifyQuery, type QueryCandidateKind } from "@zk-bridge/shared";
import { formatRoute } from "../app/route";
import { nativeTokensOf } from "../bridge/bridge-model";
import { CONTRACT_NAMES } from "./contract-names";
import type { ProofRow } from "./explore-source";

/** What the band recognised. */
export type Recognised = { readonly kind: "hash" | "address" | "partial" | "number" | "cid" | "symbol" | "empty" | "unknown"; readonly label: string };

const RECOGNISED: Readonly<Record<QueryCandidateKind, Recognised>> = {
  "message-id": { kind: "hash", label: "Transaction or message hash" },
  transaction: { kind: "hash", label: "Transaction or message hash" },
  address: { kind: "address", label: "Address" },
  "hex-prefix": { kind: "partial", label: "Partial hash or address" },
  proof: { kind: "number", label: "Slot, block or proof number" },
  slot: { kind: "number", label: "Slot, block or proof number" },
  block: { kind: "number", label: "Slot, block or proof number" },
  cid: { kind: "cid", label: "Release CID" },
  symbol: { kind: "symbol", label: "Token symbol" },
};

/**
 * What a typed text looks like. The reading is the shared one (`classifyQuery` of @zkb/core), the one that the palette,
 * the indexer's search route and the indexer's page use.
 *
 * @param text The text in the band.
 */
export const recognise = (text: string): Recognised => {
  const { query, candidates } = classifyQuery(text);
  if (query === "") return { kind: "empty", label: "" };
  const first = candidates[0];
  return first === undefined ? { kind: "unknown", label: "Nothing recognised" } : RECOGNISED[first.kind];
};

/** One result. `match` is the part of `title` or `sub` that matched (underlined on the page). */
export type SearchItem = {
  readonly title: string;
  readonly sub: string;
  readonly href: string;
  readonly match: string | null;
  /** The chains to show as icons: one chain, or a route (from, to). */
  readonly chains: readonly number[];
};

/** Results of one kind. */
export type SearchGroup = { readonly title: string; readonly items: readonly SearchItem[] };

/** What the search reads. */
export type SearchData = {
  readonly pair: PairConfig;
  readonly proofs: readonly ProofRow[];
  readonly tokens: readonly TokenInfo[];
  readonly feed: readonly FeedItem[];
};


const short = (hash: string): string => `${hash.slice(0, 10)}…${hash.slice(-4)}`;
const chainOfSide = (pair: PairConfig, side: "first" | "second"): ChainConfig => (side === "first" ? pair.first : pair.second);
const tokenHref = (token: TokenInfo): string => formatRoute({ name: "explore", page: { kind: "token", id: `${token.side}:${token.address}` } });
const txHref = (chainId: number, hash: string): string => formatRoute({ name: "explore", page: { kind: "tx", chainId, id: hash } });
const proofOtherChain = (pair: PairConfig, chainId: number): number => (pair.first.chainId === chainId ? pair.second.chainId : pair.first.chainId);

/**
 * Searches the loaded data.
 *
 * @param text The text in the band.
 * @param data What the page has loaded.
 */
export const searchExplore = (text: string, data: SearchData): readonly SearchGroup[] => {
  const value = text.trim();
  const { kind } = recognise(value);
  const lower = value.toLowerCase();
  const { pair } = data;
  const chains = [pair.first, pair.second];
  const groups: SearchGroup[] = [];
  const add = (title: string, items: readonly SearchItem[]): void => {
    if (items.length > 0) groups.push({ title, items });
  };

  if (kind === "hash" || kind === "partial" || kind === "address") {
    const prefix = (candidate: string | null): boolean => candidate !== null && candidate.toLowerCase().startsWith(lower);
    const transactions: SearchItem[] = [];
    for (const proof of data.proofs) {
      if (prefix(proof.transactionHash)) transactions.push({ title: "Light-client update posted", sub: short(proof.transactionHash), href: txHref(proof.chainId, proof.transactionHash), match: value, chains: [proof.chainId] });
    }
    for (const item of data.feed) {
      const source = item.direction === "first-to-second" ? pair.first : pair.second;
      const destination = source === pair.first ? pair.second : pair.first;
      if (prefix(item.sourceTransactionHash)) transactions.push({ title: "Transfer sent", sub: short(item.sourceTransactionHash), href: txHref(source.chainId, item.sourceTransactionHash), match: value, chains: [source.chainId] });
      if (prefix(item.destinationTransactionHash)) transactions.push({ title: "Transfer delivered", sub: short(item.destinationTransactionHash!), href: txHref(destination.chainId, item.destinationTransactionHash!), match: value, chains: [destination.chainId] });
    }
    if (kind === "hash" && transactions.length === 0 && !data.feed.some((item) => item.id.toLowerCase() === lower)) {
      for (const chain of chains) transactions.push({ title: `Transaction on ${chain.name}`, sub: short(value), href: txHref(chain.chainId, value), match: null, chains: [chain.chainId] });
    }
    if (kind === "address") {
      add("Addresses", [{ title: "Address", sub: value, href: formatRoute({ name: "explore", page: { kind: "address", id: value } }), match: null, chains: [] }]);
    }
    add("Transactions", transactions);
    add(
      "Proofs",
      data.proofs.filter((proof) => prefix(proof.transactionHash)).map((proof) => ({ title: `Proof #${proof.number}`, sub: `slot ${proof.slot} · in tx ${short(proof.transactionHash)}`, href: formatRoute({ name: "explore", page: { kind: "proof", chainId: proof.chainId, id: String(proof.number) } }), match: value, chains: [proofOtherChain(pair, proof.chainId), proof.chainId] })),
    );
    add(
      "Messages",
      data.feed.filter((item) => prefix(item.id)).map((item) => ({ title: `Message ${short(item.id)}`, sub: item.status, href: formatRoute({ name: "message", messageId: item.id }), match: value, chains: [] })),
    );
    const contracts: SearchItem[] = [];
    for (const chain of chains) {
      for (const [key, name] of Object.entries(CONTRACT_NAMES) as [keyof ChainConfig["contracts"], string][]) {
        const address = chain.contracts[key];
        if (prefix(address)) contracts.push({ title: name, sub: short(address!), href: formatRoute({ name: "explore", page: { kind: "contract", chainId: chain.chainId, id: address as Address } }), match: value, chains: [chain.chainId] });
      }
    }
    add("Contracts", contracts);
    add("Tokens", data.tokens.filter((token) => prefix(token.address)).map((token) => ({ title: token.symbol, sub: short(token.address), href: tokenHref(token), match: value, chains: [chainOfSide(pair, token.side).chainId] })));
  }

  if (kind === "number") {
    const n = BigInt(value);
    add(
      "Proofs",
      data.proofs
        .filter((proof) => proof.slot === n || proof.executionBlockNumber === n || proof.blockNumber === n || BigInt(proof.number) === n)
        .map((proof) => ({ title: `Proof #${proof.number}`, sub: `slot ${proof.slot} · block ${proof.executionBlockNumber}`, href: formatRoute({ name: "explore", page: { kind: "proof", chainId: proof.chainId, id: String(proof.number) } }), match: value, chains: [proofOtherChain(pair, proof.chainId), proof.chainId] })),
    );
    add("Slots", [{ title: `Slot ${value}`, sub: "beacon chain", href: formatRoute({ name: "explore", page: { kind: "slot", id: value } }), match: value, chains: [] }]);
    add(
      "Blocks",
      chains.map((chain) => ({ title: `Block ${value}`, sub: chain.name, href: formatRoute({ name: "explore", page: { kind: "block", chainId: chain.chainId, id: value } }), match: value, chains: [chain.chainId] })),
    );
  }

  if (kind === "symbol") {
    const tokens = [...data.tokens, ...nativeTokensOf(pair)].filter((token) => token.symbol.toLowerCase().includes(lower));
    add(
      "Tokens",
      tokens.map((token) => {
        const at = token.symbol.toLowerCase().indexOf(lower);
        return { title: token.symbol, sub: chainOfSide(pair, token.side).name, href: tokenHref(token), match: token.symbol.slice(at, at + value.length), chains: [chainOfSide(pair, token.side).chainId] };
      }),
    );
  }

  if (kind === "cid") add("Releases", [{ title: "Release", sub: short(value), href: formatRoute({ name: "explore", page: { kind: "release", id: value } }), match: null, chains: [] }]);
  return groups;
};
