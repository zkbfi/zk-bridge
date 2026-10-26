/**
 * Support for tests of the live connections: a deployment file that the shared registry accepts, fake connections that
 * record each build, and a fake chain access that records the environment it got. Nothing here touches a network.
 */
import { loadPair, redactConnectionText, type ExplorerConnection, type ExplorerConnectionInput, type Pair, type SourceStatus } from '@zk-bridge/shared'
import type { ChainAccess } from '../../src/chain/chain-access'
import { buildPairConfig } from '../../src/config/pairs'
import type { PairConfig } from '../../src/model/types'

/** The default RPC URL that the deployment file names for chain 1. A made-up value. */
export const REGISTRY_RPC_URL = 'https://registry.example.test/rpc-default-one'

const section = (chainId: number, digit: string, extra: Record<string, unknown> = {}) => ({
  chain_id: chainId,
  bridge: `0x${digit}b${'0'.repeat(38)}`,
  mediator: `0x${digit}d${'0'.repeat(38)}`,
  token_factory: `0x${digit}f${'0'.repeat(38)}`,
  native_router: `0x${digit}a${'0'.repeat(38)}`,
  wrapped_native: `0x${digit}e${'0'.repeat(38)}`,
  gate: `0x${digit}c${'0'.repeat(38)}`,
  light_client: `0x${digit}9${'0'.repeat(38)}`,
  start_block: 10,
  ...extra,
})

/** The deployment file of the live test pair. Chain 1 names a default RPC URL. Chain 369 names none. */
export const LIVE_DEPLOYMENT = { chain_a: section(1, '1', { rpc_url: REGISTRY_RPC_URL }), chain_b: section(369, '2') }

/** The pair as the views see it and as the RPC source sees it. */
export function livePair(): { readonly pair: PairConfig; readonly sharedPair: Pair } {
  return {
    pair: buildPairConfig('eth-pls', LIVE_DEPLOYMENT),
    sharedPair: loadPair({ pairName: 'eth-pls', environment: {}, deployment: LIVE_DEPLOYMENT, requireRpcUrl: false }),
  }
}

/** A connection that a test controls. */
export type FakeConnection = ExplorerConnection & {
  readonly input: ExplorerConnectionInput
  /** Changes the status and tells the listeners. */
  setStatus(status: SourceStatus): void
  /** How often `checkNow` ran. */
  checks(): number
}

/** The status of a healthy indexer. */
export const INDEXER_STATUS: SourceStatus = { kind: 'indexer', reason: null, label: 'indexer' }

/** The status of a fallback to RPC for a reason. */
export function fallbackStatus(message: string): SourceStatus {
  return { kind: 'rpc', reason: { code: 'unreachable', message }, label: `RPC fallback: ${message}` }
}

/** A factory of fake connections. Each call of `createConnection` adds one to `created`. */
export function fakeConnections(options: { readonly checkNow?: () => Promise<void> } = {}) {
  const created: FakeConnection[] = []
  const createConnection = (input: ExplorerConnectionInput): FakeConnection => {
    const urls = [input.resolved.indexerUrl, ...Object.values(input.resolved.rpcUrls)].flatMap((setting) => (setting === null ? [] : [setting.value]))
    const listeners = new Set<(status: SourceStatus) => void>()
    let status = INDEXER_STATUS
    let checks = 0
    const connection: FakeConnection = {
      input,
      resolved: input.resolved,
      baseUrl: input.resolved.indexerUrl?.value ?? 'http://indexer.not-set.invalid',
      getJson: async () => {
        throw new Error(`no data from ${input.resolved.indexerUrl?.value ?? 'no indexer'}`)
      },
      request: async () => ({ status: 404, body: null }),
      run: (operations) => operations.viaIndexer(),
      rpc: {} as ExplorerConnection['rpc'],
      status: () => status,
      subscribe(listener) {
        listeners.add(listener)
        return () => void listeners.delete(listener)
      },
      async checkNow() {
        checks += 1
        await options.checkNow?.()
      },
      redact: (text) => redactConnectionText(text, urls),
      setStatus(next) {
        status = next
        for (const listener of [...listeners]) listener(next)
      },
      checks: () => checks,
    }
    created.push(connection)
    return connection
  }
  return { created, createConnection, latest: () => created[created.length - 1]! }
}

/** A factory of fake chain access. Each build records its environment. The `flowClient` of build N throws `build N`. */
export function fakeChainAccesses() {
  const environments: Record<string, string | undefined>[] = []
  const createChainAccess = (_pair: PairConfig, environment: Record<string, string | undefined>): ChainAccess => {
    environments.push(environment)
    const build = environments.length
    return {
      mode: 'rpc',
      readSnapshots: async () => {
        throw new Error(`build ${build}`)
      },
      nativeBalances: async () => {
        throw new Error(`build ${build}`)
      },
      readRewardAddress: async () => {
        throw new Error(`build ${build}`)
      },
      flowClient: () => {
        throw new Error(`build ${build}`)
      },
    }
  }
  return { environments, createChainAccess }
}
