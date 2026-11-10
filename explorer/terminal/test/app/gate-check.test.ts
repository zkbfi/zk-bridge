import { describe, expect, test } from 'bun:test'
import type { GateChainClient } from '@zk-bridge/shared'
import { terminalGateCheck, TERMINAL_NO_BEACON_TEXT } from '../../src/app/gate-check'
import type { ChainAccess } from '../../src/chain/chain-access'

const GATE = '0x1782a38a37ce9fb9f53b0585b23b833847007e20'
const ACCOUNT = '0x8D43a3DF4951652d04bA29098D292136Af004Bdd'

/** A flow client whose gate enforces and has not confirmed the epoch of the next block. */
function enforcingClient(): GateChainClient {
  const answers: Record<string, unknown> = {
    mode: 0,
    enforcing: true,
    isSealed: false,
    confirmedEpoch: [0n, false],
    genesisTime: 0n,
    secondsPerSlot: 12n,
    slotsPerEpoch: 32n,
    genesisValidatorsRoot: `0x${'d8'.repeat(32)}`,
    beaconRoots: '0x000F3df6D732807Ef1319fB7B8bB8522d0Beac02',
  }
  return {
    getBlock: async () => ({ number: 10n, timestamp: 38_400n, parentBeaconBlockRoot: `0x${'aa'.repeat(32)}` }),
    readContract: async ({ functionName }: { functionName: string }) => answers[functionName],
    call: async () => ({ data: `0x${'aa'.repeat(32)}` }),
    estimateGas: async () => 0n,
  } as unknown as GateChainClient
}

describe('terminalGateCheck', () => {
  test('is absent with fixture data, which reaches no chain', () => {
    expect(terminalGateCheck({ connection: null, chainAccess: { flowClient: () => enforcingClient() as never } })).toBeUndefined()
  })

  test('asks the beacon endpoints of the connection in force, through the given fetch', async () => {
    const asked: string[] = []
    const fetch = (async (url: string) => {
      asked.push(url)
      return new Response('{}', { status: 503 })
    }) as unknown as typeof globalThis.fetch
    const chainAccess: Pick<ChainAccess, 'flowClient'> = { flowClient: () => enforcingClient() as never }
    const connection = { resolved: () => ({ beaconUrls: { 11155111: { value: 'https://beacon.example', source: 'user' as const } } }) }
    const check = terminalGateCheck({ connection: connection as never, chainAccess, fetch })!
    await expect(check({ chainId: 11155111, gate: GATE, account: ACCOUNT })).rejects.toMatchObject({ code: 'beacon-request-failed' })
    expect(asked).toEqual([`https://beacon.example/eth/v1/beacon/headers/0x${'aa'.repeat(32)}`])
  })

  test('says in its own words that a chain has no beacon endpoint', async () => {
    const check = terminalGateCheck({ connection: { resolved: () => ({}) } as never, chainAccess: { flowClient: () => enforcingClient() as never } })!
    // Chain 5 has no default beacon API.
    await expect(check({ chainId: 5, gate: GATE, account: ACCOUNT })).rejects.toMatchObject({ code: 'beacon-request-failed', message: TERMINAL_NO_BEACON_TEXT })
  })
})
