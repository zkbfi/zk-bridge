/**
 * The RPCs a chain uses when nothing else names one (not the user, the build, or the deployment file). Owner
 * (2026-10-31): "valve.city should be your default", with a public RPC behind it, because the demo key has a daily
 * quota; a key scoped to zkb.fi comes later. Users can replace them in Settings.
 */
export const DEFAULT_RPC_CHAIN_IDS: readonly number[] = [1, 369, 11155111, 943]

/**
 * The public RPCs behind the valve.city demo key. Owner (2026-11-07): "we should also use publicnodes as fallback as
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
 * Every default RPC of a chain: the valve.city demo key first, then the public RPCs. Reads are spread across all of them
 * (see `chain/rpc-transport.ts`). Empty for a chain with no default.
 */
export function defaultRpcUrls(chainId: number): readonly string[] {
  if (!DEFAULT_RPC_CHAIN_IDS.includes(chainId)) return []
  return [`https://one.valve.city/rpc/vk_demo/evm/${chainId}`, ...(PUBLIC_RPC[chainId] ?? [])]
}

/** The first default RPC of a chain (valve.city), or null for a chain with no default. */
export function defaultRpcUrl(chainId: number): string | null {
  return defaultRpcUrls(chainId)[0] ?? null
}
