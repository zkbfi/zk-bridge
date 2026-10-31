/**
 * The RPCs a chain uses when nothing else names one (not the user, the build, or the deployment file). Owner
 * (2026-10-31): public RPCs first, the valve.city demo key as the fallback, because the demo key has a daily quota
 * that a public site exhausts; a key scoped to zkb.fi comes later. Users can replace them in Settings.
 */
export const DEFAULT_RPC_CHAIN_IDS: readonly number[] = [1, 369, 11155111, 943]

const PUBLIC_RPC: Readonly<Record<number, string>> = {
  1: 'https://ethereum-rpc.publicnode.com',
  369: 'https://rpc.pulsechain.com',
  11155111: 'https://ethereum-sepolia-rpc.publicnode.com',
  943: 'https://rpc.v4.testnet.pulsechain.com',
}

/** Every default RPC of a chain in the order to try them: the public RPC, then the valve.city demo key. Empty for a chain with no default. */
export function defaultRpcUrls(chainId: number): readonly string[] {
  if (!DEFAULT_RPC_CHAIN_IDS.includes(chainId)) return []
  return [PUBLIC_RPC[chainId] as string, `https://one.valve.city/rpc/vk_demo/evm/${chainId}`]
}

/** The first default RPC of a chain (the public one), or null for a chain with no default. */
export function defaultRpcUrl(chainId: number): string | null {
  return defaultRpcUrls(chainId)[0] ?? null
}
