/**
 * The RPC a chain uses when nothing else names one (not the user, the build, or the deployment file): the valve.city
 * demo key, which serves Ethereum, PulseChain and their testnets. Owner: "you can use the valve.city demo key as a
 * default for both chains. also supports testnets". Users can replace it.
 */
export const DEFAULT_RPC_CHAIN_IDS: readonly number[] = [1, 369, 11155111, 943]

/** The valve.city demo RPC of a chain, or null for a chain it does not serve. */
export function defaultRpcUrl(chainId: number): string | null {
  return DEFAULT_RPC_CHAIN_IDS.includes(chainId) ? `https://one.valve.city/rpc/vk_demo/evm/${chainId}` : null
}
