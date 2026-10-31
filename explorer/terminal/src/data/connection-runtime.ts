/**
 * The live connections of a dashboard: the indexer with the RPC source behind it, and the chain access for
 * transactions. The dashboard holds one runtime for its whole life. The data source and the chain access that it hands
 * out stay the same objects when the settings change, and they forward to the newest clients. So a setting takes
 * effect on the next read, with no restart.
 *
 * The terminal and the web page both use this file. It touches no terminal library and no browser global.
 */
import {
  DEFAULT_INDEXER_URL,
  createExplorerConnection,
  describeSource,
  fetchClient,
  maskUrl,
  parseConnectionUrl,
  redactConnectionText,
  resolveConnection,
  testIndexerUrl,
  testRpcChainId,
  type ConnectionLayer,
  type ConnectionSettings,
  type ExplorerConnection,
  type ExplorerConnectionInput,
  type HttpClient,
  type Pair,
  type ResolvedConnection,
  type SourceStatus,
  type TestOutcome,
} from '@zk-bridge/shared'
import { createRpcChainAccess, type ChainAccess } from '../chain/chain-access'
import { defaultBeaconUrl } from '../config/default-beacon'
import type { PairConfig } from '../model/types'
import type { DataSource } from './data-source'
import { createIndexerDataSource } from './indexer-data-source'

/** The inputs of {@link createConnectionRuntime}. */
export interface ConnectionRuntimeInput {
  /** The pair as the views see it. */
  readonly pair: PairConfig
  /** The pair as the RPC source needs it: addresses and start blocks. */
  readonly sharedPair: Pair
  /** The settings of the environment or of the deployment of the page. */
  readonly environment: ConnectionLayer
  /** What the user set before, from the secret store or from the browser. */
  readonly user: ConnectionSettings
  /** The RPC of a chain that nothing else names, or null. The web dapp passes the valve.city demo RPC. */
  readonly fallbackRpcUrl?: (chainId: number) => string | null
  /** Replaces the connection factory. A test passes a fake. */
  readonly createConnection?: (input: ExplorerConnectionInput) => ExplorerConnection
  /** Replaces the chain access factory. The environment maps the RPC variable name of each chain to its URL. */
  readonly createChainAccess?: (pair: PairConfig, environment: Record<string, string | undefined>) => ChainAccess
  /** Options that go to every connection, such as the clock or the block span. */
  readonly connectionOptions?: Partial<ExplorerConnectionInput>
}

/** How the screens read and change the connections. */
export interface ConnectionRuntime {
  /** A data source that forwards to the newest connection. Its `label` follows the active source. */
  readonly dataSource: DataSource
  /** A chain access that forwards to the newest RPC URLs. */
  readonly chainAccess: ChainAccess
  /**
   * The pair with its contract addresses and start blocks, for a read that scans the chains itself (the history).
   * The runtime sets it. A fake in a test may leave it out.
   */
  readonly sharedPair?: Pair
  /** The newest connection. */
  connection(): ExplorerConnection
  /** The URLs in force, with where each one comes from. */
  resolved(): ResolvedConnection
  /** The settings that the user typed, as the runtime holds them. */
  user(): ConnectionSettings
  /** Which source answers, and why. */
  source(): SourceStatus
  /** Calls the listener when the active source changes and when the settings change. Returns the unsubscribe function. */
  subscribe(listener: () => void): () => void
  /** Replaces the settings of the user. The new clients are in use at once. */
  apply(user: ConnectionSettings): void
  /**
   * Asks the node of an RPC URL for its chain identifier. A URL of another chain, or a URL that fails, is refused.
   *
   * @param chainId The chain that the URL must serve.
   * @param url The URL to test. It is checked for form first.
   * @param http Replaces the HTTP client.
   */
  testRpcUrl(chainId: number, url: string, http?: HttpClient): Promise<TestOutcome>
  /**
   * Asks an indexer URL for `/api/heads`. A URL that does not answer like an explorer indexer is refused.
   *
   * @param url The URL to test. It is checked for form first.
   * @param http Replaces the HTTP client.
   */
  testIndexer(url: string, http?: HttpClient): Promise<TestOutcome>
  /** Removes every URL and every part of one from a text. */
  redact(text: string): string
}

/** The layer that the pair registry offers: the RPC URL of the deployment file and the standard indexer address. */
/**
 * The registry's defaults. A chain the deployment gives no RPC gets `fallbackRpcUrl` (the web dapp passes the
 * valve.city demo RPC; the terminal passes nothing, so such a chain has no URL).
 */
export function registryLayer(sharedPair: Pair, fallbackRpcUrl: (chainId: number) => string | null = () => null): ConnectionLayer {
  return {
    indexerUrl: DEFAULT_INDEXER_URL,
    rpcUrls: Object.fromEntries(sharedPair.sides.map((side) => [side.chainId, side.rpcUrl === '' ? fallbackRpcUrl(side.chainId) : side.rpcUrl])),
    // The pair's own beacon endpoint when it names one, else the chain's default (valve.city first).
    beaconUrls: Object.fromEntries(sharedPair.sides.map((side) => [side.chainId, side.beaconUrl ?? defaultBeaconUrl(side.chainId)])),
  }
}

/**
 * A line for a screen that tells where a resolved setting comes from, without its value.
 *
 * @param setting The resolved setting, or null.
 */
export function describeSetting(setting: ResolvedConnection['indexerUrl']): string {
  return setting === null ? 'not set' : `${maskUrl(setting.value)} (${describeSource(setting.source)})`
}

/** Creates the runtime. */
export function createConnectionRuntime(input: ConnectionRuntimeInput): ConnectionRuntime {
  const { pair, sharedPair } = input
  const chains = [pair.first, pair.second]
  const createConnection = input.createConnection ?? createExplorerConnection
  const createChainAccess = input.createChainAccess ?? ((chainPair, environment) => createRpcChainAccess(chainPair, environment))
  const listeners = new Set<() => void>()
  const notify = () => {
    for (const listener of [...listeners]) listener()
  }

  let user = input.user
  let resolved: ResolvedConnection
  let connection: ExplorerConnection
  let dataSource: DataSource
  let chainAccess: ChainAccess
  let stopWatching: () => void = () => undefined

  function build(): void {
    stopWatching()
    resolved = resolveConnection({
      chainIds: chains.map((chain) => chain.chainId),
      user,
      environment: input.environment,
      registry: registryLayer(sharedPair, input.fallbackRpcUrl),
    })
    connection = createConnection({ pair: sharedPair, resolved, ...input.connectionOptions })
    dataSource = createIndexerDataSource({ baseUrl: connection.baseUrl, pair, getJson: (url) => connection.getJson(url) })
    chainAccess = createChainAccess(
      pair,
      Object.fromEntries(chains.map((chain) => [chain.rpcEnvironmentVariable, resolved.rpcUrls[chain.chainId]?.value])),
    )
    stopWatching = connection.subscribe(notify)
  }
  build()

  return {
    dataSource: {
      get label() {
        return connection.status().label
      },
      listPairs: () => dataSource.listPairs(),
      getSummary: (pairId) => dataSource.getSummary(pairId),
      getFeed: (pairId, filter, limit) => dataSource.getFeed(pairId, filter, limit),
      getHeads: (pairId) => dataSource.getHeads(pairId),
      getAudit: (pairId) => dataSource.getAudit(pairId),
      getProver: (pairId) => dataSource.getProver(pairId),
      listTokens: (pairId) => dataSource.listTokens(pairId),
      getDeliveryCost: (chainId) => dataSource.getDeliveryCost(chainId),
    },
    chainAccess: {
      get mode() {
        return chainAccess.mode
      },
      readSnapshots: (request) => chainAccess.readSnapshots(request),
      nativeBalances: (addresses) => chainAccess.nativeBalances(addresses),
      readRouterAddresses: (request) => chainAccess.readRouterAddresses(request),
      flowClient: (chainId) => chainAccess.flowClient(chainId),
    },
    sharedPair,
    connection: () => connection,
    resolved: () => resolved,
    user: () => user,
    source: () => connection.status(),
    subscribe(listener) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    apply(next) {
      user = next
      build()
      notify()
    },
    async testRpcUrl(chainId, url, http) {
      const parsed = parseConnectionUrl(url, 'rpc')
      if (!parsed.ok) return { ok: 'fail', message: parsed.message }
      const outcome = await testRpcChainId(http ?? fetchClient, { rpcUrl: parsed.url, expectedChainId: chainId })
      return { ok: outcome.ok, message: connection.redact(redactConnectionText(outcome.message, [parsed.url])) }
    },
    async testIndexer(url, http) {
      const parsed = parseConnectionUrl(url, 'indexer')
      if (!parsed.ok) return { ok: 'fail', message: parsed.message }
      const outcome = await testIndexerUrl(http ?? fetchClient, { indexerUrl: parsed.url })
      return { ok: outcome.ok, message: connection.redact(redactConnectionText(outcome.message, [parsed.url])) }
    },
    redact: (text) => connection.redact(text),
  }
}
