/**
 * The fork cutover of the terminal and of the web page (the web page imports this file too): the route of a send, and the
 * shared `createForkCutoverCheck` over the chain access and the beacon endpoints in force. A send from a chain is refused
 * before signing when the light client on the other chain cannot follow a fork that the source chain is about to make
 * (`decideForkCutover` of `@zk-bridge/shared`). Nothing here sends.
 */
import { createForkCutoverCheck, type CutoverRoute, type ForkCutoverCheck } from '@zk-bridge/shared'
import type { ChainAccess } from '../chain/chain-access'
import { beaconUrlsFor } from '../config/default-beacon'
import type { ConnectionRuntime } from '../data/connection-runtime'
import type { PairConfig } from '../model/types'

/**
 * The route of a send from a chain of the pair: the light client that follows it is the one on the other chain.
 *
 * @param pair The pair.
 * @returns A function from the source chain identifier to its route, or null for a chain that is not in the pair.
 */
export function cutoverRouteOf(pair: PairConfig): (sourceChainId: number) => CutoverRoute | null {
  return (sourceChainId) => {
    if (sourceChainId === pair.first.chainId) return { destinationChainId: pair.second.chainId, lightClient: pair.second.contracts.lightClient }
    if (sourceChainId === pair.second.chainId) return { destinationChainId: pair.first.chainId, lightClient: pair.first.contracts.lightClient }
    return null
  }
}

/**
 * The cutover check of a live connection, or undefined with fixture data (no connection), which reaches no chain.
 *
 * @param input.pair The pair.
 * @param input.connection The live connections, or null in fixture mode.
 * @param input.chainAccess The chain access whose flow clients read the light client heads.
 * @param input.fetch The `fetch` to use. Default: the global one.
 * @param input.nowSeconds The clock in seconds. Default: the system clock.
 */
export function forkCutoverCheckFor(input: {
  readonly pair: PairConfig
  readonly connection: Pick<ConnectionRuntime, 'resolved'> | null
  readonly chainAccess: Pick<ChainAccess, 'flowClient'>
  readonly fetch?: typeof fetch
  readonly nowSeconds?: () => number
}): ForkCutoverCheck | undefined {
  const { connection, chainAccess } = input
  if (connection === null) return undefined
  return createForkCutoverCheck({
    routeOf: cutoverRouteOf(input.pair),
    // The flow client of a live dashboard is a viem public client; its type names only what the flow needs.
    clientFor: (chainId) => chainAccess.flowClient(chainId) as never,
    beaconUrlsFor: (chainId) => beaconUrlsFor(connection.resolved(), chainId),
    ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
    ...(input.nowSeconds === undefined ? {} : { nowSeconds: input.nowSeconds }),
  })
}
