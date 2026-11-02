/**
 * Searches that go beyond the local lists: a message identifier, a transaction hash, an address, the start of a hash, a
 * beacon slot, a block, a proof, a release. They run through the shared search (`resolve` of @zkb/data), the same one
 * that the indexer's search route and the indexer's page use, over the readers of this page: the indexer client and the
 * tokens it has loaded. Every result carries its links to the other surfaces.
 */
import type { Hex } from "viem";
import type { PairConfig, TokenInfo } from "@terminal/model/types";
import { classifyQuery, resolve, type SearchMessage, type SearchSources, type SearchToken } from "@zk-bridge/shared";
import type { IndexerClient } from "../data/indexer-client";
import type { MessageDetail } from "../data/message-detail";
import { PALETTE_SITES, crossResult, searchChainsOf, type SearchResult } from "./search-model";

/** What the lookup found, and why it found nothing when it did not. */
export type IdentifierSearchOutcome = {
  readonly results: readonly SearchResult[];
  /** A sentence for the user when a lookup failed or found nothing sure. Null when there is a result. */
  readonly problem: string | null;
};

/** Whether the shared search has anything to look up for this text: a hash, an address, a number, a CID. A word is a local search. */
export const isCrossReferenced = (query: string): boolean => {
  const { candidates, unsupported } = classifyQuery(query);
  return unsupported !== null || candidates.some((candidate) => candidate.kind !== "symbol");
};

const messageOf = (detail: MessageDetail): SearchMessage => ({
  messageId: detail.id,
  kind: detail.kind,
  status: detail.status,
  sourceChainId: detail.sourceChainId,
  destinationChainId: detail.destinationChainId,
  sentTransactionHash: detail.sourceTransactionHash,
  deliveredTransactionHash: detail.destinationTransactionHash,
  symbol: detail.transfer?.sourceToken.symbol ?? null,
});

const tokenOf = (pair: PairConfig, token: TokenInfo): SearchToken => ({
  chainId: (token.side === "first" ? pair.first : pair.second).chainId,
  address: token.address,
  symbol: token.symbol,
  name: null,
});

/**
 * The readers of the shared search over this page's data.
 *
 * @param dependencies The indexer client, the pair and the tokens that the page has loaded.
 */
export const paletteSources = (dependencies: { readonly indexer: IndexerClient; readonly pair: PairConfig; readonly tokens: readonly TokenInfo[] }): SearchSources => {
  const { indexer, pair, tokens } = dependencies;
  return {
    sites: PALETTE_SITES,
    chains: searchChainsOf(pair),
    indexer: {
      message: async (messageId) => {
        const detail = await indexer.message(messageId as Hex);
        return detail === null ? null : messageOf(detail);
      },
      messageByTransaction: async (hash) => {
        const messageId = await indexer.findMessageByTransaction(hash as Hex);
        const detail = messageId === null ? null : await indexer.message(messageId);
        return detail === null ? null : messageOf(detail);
      },
      tokens: async () => tokens.map((token) => tokenOf(pair, token)),
    },
  };
};

const NOTHING_SURE = "The indexer knows no message with this identifier or transaction hash.";

/**
 * Looks a query up through the shared search.
 *
 * @param query The text in the search field.
 * @param dependencies The indexer client, the pair and the loaded tokens.
 */
export const searchCrossReferenced = async (
  query: string,
  dependencies: { readonly indexer: IndexerClient; readonly pair: PairConfig; readonly tokens: readonly TokenInfo[] },
): Promise<IdentifierSearchOutcome> => {
  const resolution = await resolve(query, paletteSources(dependencies));
  const results = resolution.results.map(crossResult);
  const asksForHash = resolution.candidates.some((candidate) => candidate.kind === "message-id");
  const sure = resolution.results.some((result) => result.confirmed);
  if (resolution.unsupported !== null) return { results, problem: "Names such as ENS names are not searched. Try an address, a hash or a number." };
  if (resolution.problems.length > 0) return { results, problem: `The indexer lookup failed: ${(resolution.problems[0] as string).replace(/^indexer: /, "")}` };
  return { results, problem: asksForHash && !sure ? NOTHING_SURE : null };
};
