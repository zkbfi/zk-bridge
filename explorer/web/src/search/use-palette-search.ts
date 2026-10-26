import { useEffect, useMemo, useState } from "react";
import { useTokens } from "../app/queries";
import { useServices } from "../app/services";
import { DOC_PAGES, type DocPage } from "../docs/docs-index";
import { searchIdentifiers } from "./identifier-search";
import {
  actionResults,
  classifyQuery,
  docResults,
  emptyQueryGroups,
  flattenGroups,
  groupResults,
  pairResults,
  rankResults,
  tokenResults,
  viewResults,
  type ResultGroup,
  type SearchResult,
} from "./search-model";

/** Input of {@link usePaletteSearch}. */
export type PaletteSearchInput = {
  readonly query: string;
  /** The results that the user opened lately. */
  readonly recent: readonly SearchResult[];
  readonly walletConnected: boolean;
  /** The documentation pages to search. Default: all. */
  readonly docPages?: readonly DocPage[];
};

/** What the palette shows. */
export type PaletteSearch = {
  readonly groups: readonly ResultGroup[];
  /** The results in the order of the arrow keys. */
  readonly flat: readonly SearchResult[];
  /** True while the indexer answers an identifier lookup. */
  readonly loading: boolean;
  /** A sentence about a failed or empty lookup, or null. */
  readonly problem: string | null;
};

type Lookup = { readonly query: string; readonly results: readonly SearchResult[]; readonly problem: string | null };

/**
 * The results of the palette for a query. Views, pairs, tokens, actions and docs come from local lists. A message
 * identifier, a transaction hash and an address also read the indexer.
 *
 * @param input The query, the recent results and the wallet state.
 */
export const usePaletteSearch = (input: PaletteSearchInput): PaletteSearch => {
  const { pair, indexer, knownPairs } = useServices();
  const tokens = useTokens(pair.id);
  const [lookup, setLookup] = useState<Lookup | null>(null);
  const shape = useMemo(() => classifyQuery(input.query), [input.query]);

  const local = useMemo(
    () => [
      ...viewResults(pair.id),
      ...pairResults(knownPairs),
      ...tokenResults(tokens.data ?? [], pair),
      ...actionResults({ pair, walletConnected: input.walletConnected }),
      ...docResults(input.docPages ?? DOC_PAGES),
    ],
    [pair, knownPairs, tokens.data, input.walletConnected, input.docPages],
  );

  useEffect(() => {
    if (shape.kind !== "hash" && shape.kind !== "address") return;
    let cancelled = false;
    void searchIdentifiers(shape, { indexer, pair }).then((outcome) => {
      if (!cancelled) setLookup({ query: input.query, results: outcome.results, problem: outcome.problem });
    });
    return () => {
      cancelled = true;
    };
  }, [shape, indexer, pair, input.query]);

  return useMemo((): PaletteSearch => {
    if (shape.kind === "empty") {
      const suggestions = [...viewResults(pair.id), ...actionResults({ pair, walletConnected: input.walletConnected })];
      const groups = emptyQueryGroups(input.recent, suggestions);
      return { groups, flat: flattenGroups(groups), loading: false, problem: null };
    }
    const current = lookup !== null && lookup.query === input.query ? lookup : null;
    const waiting = (shape.kind === "hash" || shape.kind === "address") && current === null;
    const ranked = rankResults(input.query, local);
    const groups = groupResults([...(current?.results ?? []), ...ranked]);
    return { groups, flat: flattenGroups(groups), loading: waiting, problem: current?.problem ?? null };
  }, [shape, lookup, input.query, input.recent, input.walletConnected, local, pair]);
};
