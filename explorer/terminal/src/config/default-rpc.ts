/**
 * The RPCs a chain uses when nothing else names one (not the user, the build, or the deployment file). Owner
 * (2026-10-31): "valve.city should be your default", with a public RPC behind it, because the demo key has a daily
 * quota; a key scoped to zkb.fi comes later. Users can replace them in Settings.
 */
export const DEFAULT_RPC_CHAIN_IDS: readonly number[] = [1, 369, 11155111, 943]

const PUBLIC_RPC: Readonly<Record<number, string>> = {
  1: 'https://ethereum-rpc.publicnode.com',
  369: 'https://rpc.pulsechain.com',
  11155111: 'https://ethereum-sepolia-rpc.publicnode.com',
  943: 'https://rpc.v4.testnet.pulsechain.com',
}

/** Every default RPC of a chain in the order to try them: the valve.city demo key, then the public RPC. Empty for a chain with no default. */
export function defaultRpcUrls(chainId: number): readonly string[] {
  if (!DEFAULT_RPC_CHAIN_IDS.includes(chainId)) return []
  return [`https://one.valve.city/rpc/vk_demo/evm/${chainId}`, PUBLIC_RPC[chainId] as string]
}

/** The first default RPC of a chain (valve.city), or null for a chain with no default. */
export function defaultRpcUrl(chainId: number): string | null {
  return defaultRpcUrls(chainId)[0] ?? null
}
