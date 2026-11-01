/**
 * What the dashboard knows about each chain beyond its contracts: the ticker of its native coin and its block
 * explorers. One source: the pair configuration, the web app's cost text and its explorer links all read this.
 */

/** One block explorer of a chain. `hashRouter` explorers keep the page after `#/` (Blockscout); the others use paths. */
export interface ExplorerInfo {
  readonly name: string
  readonly base: string
  readonly hashRouter: boolean
}

export interface ChainMetadata {
  /**
   * The ticker of the native coin of the chain, the coin its gas is paid in. A testnet coin has its own ticker, so a
   * cost on Sepolia never reads as a cost in ether: SepETH, and v4tPLS on PulseChain testnet v4 (the owner's tickers).
   */
  readonly nativeSymbol: string
  /** The explorers of the chain, the first is the main one. */
  readonly explorers: readonly ExplorerInfo[]
}

export const CHAIN_METADATA: Readonly<Record<number, ChainMetadata>> = {
  1: { nativeSymbol: 'ETH', explorers: [{ name: 'Etherscan', base: 'https://etherscan.io', hashRouter: false }] },
  11155111: { nativeSymbol: 'SepETH', explorers: [{ name: 'Sepolia Etherscan', base: 'https://sepolia.etherscan.io', hashRouter: false }] },
  369: { nativeSymbol: 'PLS', explorers: [{ name: 'PulseChain scan', base: 'https://scan.pulsechain.com', hashRouter: true }] },
  943: {
    nativeSymbol: 'v4tPLS',
    explorers: [
      { name: 'PulseChain testnet scan', base: 'https://scan.v4.testnet.pulsechain.com', hashRouter: true },
      { name: 'Otterscan', base: 'https://otter-testnet-pulsechain.g4mm4.io', hashRouter: false },
    ],
  },
}

/** The ticker of the native coin of a chain, or undefined for a chain without metadata. */
export function nativeSymbolOfChain(chainId: number): string | undefined {
  return CHAIN_METADATA[chainId]?.nativeSymbol
}

/** The pages of a chain's explorers (one link per explorer) for a transaction, a block or an address. */
export function explorerLinks(chainId: number, kind: 'tx' | 'block' | 'address', id: string): readonly { readonly name: string; readonly url: string }[] {
  return (CHAIN_METADATA[chainId]?.explorers ?? []).map((explorer) => ({ name: explorer.name, url: `${explorer.base}${explorer.hashRouter ? '/#' : ''}/${kind}/${id}` }))
}
