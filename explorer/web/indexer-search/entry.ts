/**
 * The shared search for the live page of the indexer (deploy/app-server/indexer-home), which has no build step of its
 * own. `pnpm --filter @zk-bridge/web run build:indexer-search` bundles this file with the sources of @zkb/core and
 * @zkb/data into `zkb-search.js` there, as one script that sets `ZkbSearch`. The page then builds every link with the
 * same code as the dapp and the search route.
 */
export { classifyQuery } from "../../core/src/search-query";
export { CHAIN_METADATA, chainNameOf, explorerLinks, nativeSymbolOfChain } from "../../data/src/chain-metadata";
export { ZKB_SITES, crossLinks, directionTo, lookupTextOf, searchChainsFromPair } from "../../data/src/search";
