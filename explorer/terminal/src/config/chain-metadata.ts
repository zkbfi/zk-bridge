/**
 * What the dashboard knows about each chain beyond its contracts: the ticker of its native coin and its block
 * explorers. The source moved to @zkb/data, which the search cross-links read too; this path keeps every import.
 */
export { CHAIN_METADATA, explorerLinks, nativeSymbolOfChain, type ChainMetadata, type ExplorerInfo } from '../../../data/src/chain-metadata'
