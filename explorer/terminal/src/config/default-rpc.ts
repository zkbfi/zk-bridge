/**
 * The RPCs a chain uses when nothing else names one (not the user, the build, or the deployment file). Owner
 * (2026-11-14, docs/superpowers/specs/2026-11-14-rpc-proxy-and-wallets-design.md): the valve.city demo key, which every
 * visitor shared and which answered 429, leaves the bundle; the default becomes rpc.zkb.fi, our own RPC, which serves
 * only the dapp's reads through the server's valve.city key (docs/rpc-proxy.md). The public RPCs stay behind it. Users can
 * replace them in Settings.
 */
export const DEFAULT_RPC_CHAIN_IDS: readonly number[] = [1, 369, 11155111, 943]

/** The dapp's own RPC: `https://rpc.zkb.fi/<chainId>`. */
export const ZKB_RPC_BASE = 'https://rpc.zkb.fi'

/**
 * The public RPCs behind rpc.zkb.fi. Owner (2026-11-07): "we should also use publicnodes as fallback as
 * well as the main pulsechain.com rpc" and "we should be load balancing across them". All answer `eth_chainId` correctly and
 * send `access-control-allow-origin: *`, so a browser can call them.
 */
const PUBLIC_RPC: Readonly<Record<number, readonly string[]>> = {
  1: ['https://ethereum-rpc.publicnode.com'],
  369: ['https://rpc.pulsechain.com', 'https://pulsechain-rpc.publicnode.com'],
  11155111: ['https://ethereum-sepolia-rpc.publicnode.com'],
  943: ['https://rpc.v4.testnet.pulsechain.com', 'https://pulsechain-testnet-rpc.publicnode.com'],
}

/**
 * Every default RPC of a chain: rpc.zkb.fi first, then the public RPCs. rpc.zkb.fi takes the reads while it answers; the
 * public RPCs are the fallbacks (see `chain/rpc-transport.ts`). Empty for a chain with no default.
 */
export function defaultRpcUrls(chainId: number): readonly string[] {
  if (!DEFAULT_RPC_CHAIN_IDS.includes(chainId)) return []
  return [`${ZKB_RPC_BASE}/${chainId}`, ...publicRpcUrls(chainId)]
}

/**
 * The public RPCs of a chain, without rpc.zkb.fi: what a wallet is given when it adds the chain, because a wallet sends
 * its transactions there and rpc.zkb.fi serves reads only. Empty for a chain with no default.
 */
export function publicRpcUrls(chainId: number): readonly string[] {
  return PUBLIC_RPC[chainId] ?? []
}

/** The first default RPC of a chain (rpc.zkb.fi), or null for a chain with no default. */
export function defaultRpcUrl(chainId: number): string | null {
  return defaultRpcUrls(chainId)[0] ?? null
}
