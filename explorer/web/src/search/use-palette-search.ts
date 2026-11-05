import { useEffect, useMemo, useState } from "react";
import { useTokens } from "../app/queries";
import { useServices } from "../app/services";
import { loadDocEntries, type DocEntry } from "../docs/doc-entries";
import { isCrossReferenced, searchCrossReferenced } from "./identifier-search";
import {
  actionResults,
  docResults,
  emptyQueryGroups,
  flattenGroups,
  groupResults,
  linkContextOf,
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
  /** The documentation pages to search. Default: the real pages, downloaded when the first search is typed. */
  readonly docPages?: readonly DocEntry[];
};

/** What the palette shows. */
export type PaletteSearch = {
  readonly groups: readonly ResultGroup[];
  /** The results in the order of the arrow keys. */
  readonly flat: readonly SearchResult[];
  /** True while the indexer answers a lookup of the shared search. */
  readonly loading: boolean;
  /** A sentence about a failed or empty lookup, or null. */
  readonly problem: string | null;
};

type Lookup = { readonly query: string; readonly results: readonly SearchResult[]; readonly problem: string | null };

/**
 * The results of the palette for a query. Views, pairs, tokens, actions and docs come from local lists. A message
 * identifier, a transaction hash, an address, the start of a hash, a number or a release also run through the shared
 * search, which reads the indexer and gives each result its links to the other surfaces.
 *
 * @param input The query, the recent results and the wallet state.
 */
export const usePaletteSearch = (input: PaletteSearchInput): PaletteSearch => {
  const { pair, indexer, knownPairs } = useServices();
  const tokens = useTokens(pair.id);
  const [lookup, setLookup] = useState<Lookup | null>(null);
  const empty = input.query.trim() === "";
  const crossReferenced = useMemo(() => isCrossReferenced(input.query), [input.query]);
  const loadedTokens = tokens.data;
  // The docs are a separate chunk (see docs/DocsRoute.tsx): fetch it when the first search is typed, not when the palette opens.
  const [loadedDocs, setLoadedDocs] = useState<readonly DocEntry[]>([]);
  const needsDocs = !empty && input.docPages === undefined && loadedDocs.length === 0;
  useEffect(() => {
    if (!needsDocs) return;
    let cancelled = false;
    void loadDocEntries().then(
      (entries) => {
        if (!cancelled) setLoadedDocs(entries);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [needsDocs]);
  const docPages = input.docPages ?? loadedDocs;

  const local = useMemo(
    () => [
      ...viewResults(pair.id),
      ...pairResults(knownPairs),
      ...tokenResults(tokens.data ?? [], pair, linkContextOf(pair)),
      ...actionResults({ pair, walletConnected: input.walletConnected }),
      ...docResults(docPages),
    ],
    [pair, knownPairs, tokens.data, input.walletConnected, docPages],
  );

  useEffect(() => {
    if (!crossReferenced) return;
    let cancelled = false;
    void searchCrossReferenced(input.query, { indexer, pair, tokens: loadedTokens ?? [] }).then((outcome) => {
      if (!cancelled) setLookup({ query: input.query, results: outcome.results, problem: outcome.problem });
    });
    return () => {
      cancelled = true;
    };
  }, [crossReferenced, indexer, pair, input.query, loadedTokens]);

  return useMemo((): PaletteSearch => {
    if (empty) {
      const suggestions = [...viewResults(pair.id), ...actionResults({ pair, walletConnected: input.walletConnected })];
      const groups = emptyQueryGroups(input.recent, suggestions);
      return { groups, flat: flattenGroups(groups), loading: false, problem: null };
    }
    const current = lookup !== null && lookup.query === input.query ? lookup : null;
    const waiting = crossReferenced && current === null;
    // A token found by its address is both a result of the shared search and a local one: show it once, with its links.
    const found = current?.results ?? [];
    const foundIds = new Set(found.map((result) => result.id));
    const ranked = rankResults(input.query, local).filter((result) => !foundIds.has(result.id));
    const groups = groupResults([...found, ...ranked]);
    return { groups, flat: flattenGroups(groups), loading: waiting, problem: current?.problem ?? null };
  }, [empty, crossReferenced, lookup, input.query, input.recent, input.walletConnected, local, pair]);
};
