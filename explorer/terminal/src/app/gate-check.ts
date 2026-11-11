/**
 * The deposit gate check of the terminal: the shared `createGateCheck` on the sticky flow client of the chain (so the
 * confirmation's simulation and the send hit one node), with the beacon endpoints of the connection in force at each
 * check (`beaconUrlsFor`: the pair's own endpoint or the chain's defaults, tried in order). Nothing here sends.
 */
import { createGateCheck, type ForkScheduleStore, type GateChainClient, type GateCheck } from '@zk-bridge/shared'
import type { ChainAccess } from '../chain/chain-access'
import { beaconUrlsFor } from '../config/default-beacon'
import type { ConnectionRuntime } from '../data/connection-runtime'
import type { PairConfig } from '../model/types'
import { forkCutoverCheckFor } from './fork-cutover'

/** What the terminal tells when a chain has no beacon endpoint at all. */
export const TERMINAL_NO_BEACON_TEXT = 'no beacon endpoint is known for this chain (the deployment names none, and the chain has no default)'

/**
 * The gate check of the dashboard, or undefined with fixture data (no connection), which reaches no chain.
 *
 * @param input.pair The pair, when the check also refuses sends before a fork (the fork cutover). Absent: the gate only.
 * @param input.connection The live connections, or null in fixture mode.
 * @param input.chainAccess The chain access whose flow clients the sends use.
 * @param input.fetch The `fetch` to use. Default: the global one.
 * @param input.scheduleStore Where the fork cutover keeps the last fork schedule of each chain. Absent: none is kept.
 */
export function terminalGateCheck(input: {
  readonly pair?: PairConfig
  readonly connection: Pick<ConnectionRuntime, 'resolved'> | null
  readonly chainAccess: Pick<ChainAccess, 'flowClient'>
  readonly fetch?: typeof fetch
  readonly scheduleStore?: ForkScheduleStore | undefined
}): GateCheck | undefined {
  const { connection, chainAccess } = input
  if (connection === null) return undefined
  const cutover =
    input.pair === undefined
      ? undefined
      : forkCutoverCheckFor({
          pair: input.pair,
          connection,
          chainAccess,
          ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
          scheduleStore: input.scheduleStore,
        })
  return createGateCheck({
    ...(cutover === undefined ? {} : { cutover }),
    // The flow client of a live dashboard is a viem public client; its type names only what the flow needs.
    clientFor: (chainId) => chainAccess.flowClient(chainId) as unknown as GateChainClient,
    beaconUrlsFor: (chainId) => beaconUrlsFor(connection.resolved(), chainId),
    noneText: TERMINAL_NO_BEACON_TEXT,
    ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
  })
}
