/**
 * The read interface of the dashboard. The indexer client and the fixture both implement it, so every view runs
 * without the indexer. A data source never signs and never sends.
 */
import type { DeliveryCostReport } from '@zk-bridge/shared'
import type {
  AuditRow,
  FeedFilter,
  FeedItem,
  LightClientHead,
  PairHealth,
  PairSummary,
  ProverReport,
  TokenInfo,
} from '../model/types'

/** One page of the feed. */
export interface FeedPage {
  readonly items: readonly FeedItem[]
  /** True when older rows exist beyond this page. */
  readonly hasMore: boolean
  /**
   * Unix seconds. Set by the RPC data source when it has read only part of the history: rows sent before this time are
   * not listed. Absent when the page covers the whole history.
   */
  readonly coveredFrom?: number
}

/** A data source for the dashboard. Every call may reject; the views show the error and keep the last good data. */
export interface DataSource {
  /** A short name for the footer: `indexer` or `fixture`. */
  readonly label: string
  /** One health line per pair. */
  listPairs(): Promise<readonly PairHealth[]>
  getSummary(pairId: string): Promise<PairSummary>
  /** The feed, newest first, filtered. */
  getFeed(pairId: string, filter: FeedFilter, limit: number): Promise<FeedPage>
  /** The light client heads of both chains. */
  getHeads(pairId: string): Promise<readonly LightClientHead[]>
  getAudit(pairId: string): Promise<readonly AuditRow[]>
  getProver(pairId: string): Promise<ProverReport>
  /** The tokens that the bridge has seen, on both chains. */
  listTokens(pairId: string): Promise<readonly TokenInfo[]>
  /**
   * What a delivery costs on one chain: the gas of recent deliveries, and the base fee now. The
   * "Pay for delivery" form reads it to suggest a fee.
   */
  getDeliveryCost(chainId: number): Promise<DeliveryCostReport>
}
