import type { ResolvedConnection } from '@zk-bridge/shared'
/**
 * The beacon APIs a chain uses when nothing else names one (not the user or the build). Owner (2026-10-31): "valve.city
 * should be your default", but valve.city refuses its public demo key on the beacon route ("The beacon surface requires
 * a non-public key", 403 for every chain), and the demo key left the dapp on 2026-11-14 (the server's key stays on the
 * server, docs/rpc-proxy.md). So each chain's default is its public keyless node. Users can replace it in Settings.
 *
 * The public nodes, each checked to answer `/eth/v1/beacon/genesis` with its chain's genesis validators root:
 *
 * - Ethereum: `ethereum-beacon-api.publicnode.com` (Allnodes' keyless beacon API, the same operator as the default
 *   Ethereum RPC, ethereum-rpc.publicnode.com);
 * - PulseChain and PulseChain testnet v4: the g4mm4 beacon APIs;
 * - Sepolia: ChainSafe's Lodestar node.
 */
export const DEFAULT_BEACON_CHAIN_IDS: readonly number[] = [1, 369, 11155111, 943]

const PUBLIC_BEACON: Readonly<Record<number, string>> = {
  1: 'https://ethereum-beacon-api.publicnode.com',
  369: 'https://rpc-pulsechain.g4mm4.io/beacon-api',
  11155111: 'https://lodestar-sepolia.chainsafe.io',
  943: 'https://rpc-testnet-pulsechain.g4mm4.io/beacon-api',
}

/** Every default beacon API of a chain in the order to try them: the public node. Empty for a chain with no default. */
export function defaultBeaconUrls(chainId: number): readonly string[] {
  if (!DEFAULT_BEACON_CHAIN_IDS.includes(chainId)) return []
  return [PUBLIC_BEACON[chainId] as string]
}

/** The first default beacon API of a chain (the public node), or null for a chain with no default. */
export function defaultBeaconUrl(chainId: number): string | null {
  return defaultBeaconUrls(chainId)[0] ?? null
}

/**
 * The genesis validators root of each chain's beacon chain, as `/eth/v1/beacon/genesis` answers it. The Settings check
 * compares a beacon API's answer with it, so a URL of another chain fails.
 */
export const GENESIS_VALIDATORS_ROOTS: Readonly<Record<number, `0x${string}`>> = {
  1: '0x4b363db94e286120d76eb905340fdd4e54bfe9f06bf33ff6cf5ad27f511bfe95',
  369: '0x3357ba0018a2582aeabe4ae847aa17d50a3a99aaeb66293c01f80a83aecd0c90',
  11155111: '0xd8ea171f3c94aea21ebc42a1ed61052acf3f9209c00e4efbaaddac09ed9b8078',
  943: '0xd81664ba97279a6fa0832041b4aee6009172b4750a99467ff670a9faf3a34e64',
}

/**
 * The beacon APIs to read a chain from, in order (the setting of the chain in force, one URL per chain). Like the RPC
 * transport: while the setting in force is the chain's default, the whole default list stands behind it, so one
 * provider's outage or quota does not stop a read; a URL the user or the build chose is used
 * alone. The web page and the terminal both read it.
 *
 * @param resolved The settings in force.
 * @param chainId The chain.
 */
export function beaconUrlsFor(resolved: Pick<ResolvedConnection, 'beaconUrls'>, chainId: number): readonly string[] {
  const defaults = defaultBeaconUrls(chainId)
  const setting = resolved.beaconUrls?.[chainId] ?? null
  if (setting === null) return defaults
  return setting.source === 'default' && setting.value === defaults[0] ? defaults : [setting.value]
}
