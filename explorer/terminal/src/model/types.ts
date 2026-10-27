/**
 * Domain types of the dashboard. They describe what the views show, not how the indexer stores it.
 * A data source (see `../data/data-source.ts`) maps its own records to these types.
 */
import type { Address, Hex } from 'viem'
import type { PartialFigure } from '@zk-bridge/shared'

export type { PartialFigure }

/** One of the two chains of a pair. The pair registry fixes which chain is first and which is second. */
export type ChainSide = 'first' | 'second'

/** The direction of a transfer or message: from the first chain to the second, or the other way. */
export type Direction = 'first-to-second' | 'second-to-first'

/** What a feed row is: a token transfer, or an arbitrary message. */
export type FeedKind = 'token' | 'message'

/**
 * The derived status of a transfer or message, in the order that it normally advances. The names are the ones the
 * indexer stores (`MessageStatus` in `explorer/shared`).
 * `failed_call`, `fallback_used` and `claimable` are the end states of a delivery that did not pay the recipient.
 */
export type FeedStatus =
  | 'sent'
  | 'waiting_for_finality'
  | 'covered'
  | 'delivered'
  | 'failed_call'
  | 'fallback_used'
  | 'claimable'

/** Every status, in display order. */
export const FEED_STATUSES = [
  'sent',
  'waiting_for_finality',
  'covered',
  'delivered',
  'failed_call',
  'fallback_used',
  'claimable',
] as const satisfies readonly FeedStatus[]

/** A token on one chain. */
export interface TokenInfo {
  readonly address: Address
  readonly symbol: string
  readonly decimals: number
  /** The chain that holds this token. */
  readonly side: ChainSide
  /** The token on the other chain that this token bridges to, when it exists. */
  readonly counterpart: Address | null
}

/** A chain of a pair, with the contracts that the dashboard calls. */
export interface ChainConfig {
  readonly side: ChainSide
  readonly chainId: number
  readonly name: string
  /** The symbol of the native coin, for example `ETH` or `PLS`. */
  readonly nativeSymbol: string
  /** The name of the environment variable that holds the RPC URL of this chain. */
  readonly rpcEnvironmentVariable: string
  /** The RPC URL that the deployment file names (`rpc_url`), the weakest source of the RPC URL. Absent when it names none. */
  readonly registryRpcUrl?: string
  readonly contracts: {
    readonly messageBridge: Address
    readonly tokenMediator: Address
    /** The light client of the other chain, deployed on this chain. */
    readonly lightClient: Address
    readonly wrappedNativeRouter: Address | null
    /** The wrapped native token (WETH or WPLS) that the router wraps into. */
    readonly wrappedNative: Address | null
    readonly gate: Address | null
    readonly deliveryRouter: Address | null
  }
}

/** A pair: two chains joined one to one. */
export interface PairConfig {
  readonly id: string
  readonly label: string
  readonly first: ChainConfig
  readonly second: ChainConfig
}

/** The status of the deposit gate of one chain, as `route-health` reports it. */
export type GateStatus = 'open' | 'warn' | 'stop' | 'sealed' | 'stale' | 'unknown'

/** The state of one light client: the head that the chain stores for the other chain. */
export interface LightClientHead {
  /** The chain that stores this head. The head tracks the other chain. */
  readonly side: ChainSide
  /** The slot of the stored head, or null when the light client has stored none that the indexer saw. */
  readonly storedHeadSlot: bigint | null
  /** The newest finalized slot of the tracked chain, or null when the indexer has no beacon endpoint to ask. */
  readonly finalizedSlot: bigint | null
  /** `finalizedSlot - storedHeadSlot`, never below zero, or null when the finalized slot is unknown. */
  readonly lagSlots: bigint | null
  /** Seconds per slot of the tracked chain, to show the lag as time. */
  readonly secondsPerSlot: number
  /** Unix seconds of the last update, or null when the indexer saw none. */
  readonly lastUpdateAt: number | null
}

/** An amount of one token. */
export interface TokenAmount {
  readonly token: TokenInfo
  readonly amount: bigint
}

/** One line of the global view: the health of a pair. */
export interface PairHealth {
  readonly pairId: string
  readonly label: string
  readonly firstChainName: string
  readonly secondChainName: string
  readonly heads: readonly LightClientHead[]
  readonly gates: Readonly<Record<ChainSide, GateStatus>>
  readonly inFlight: number
  readonly lastActivityAt: number | null
}

/** The summary bar of the pair view. */
export interface PairSummary {
  readonly pairId: string
  readonly heads: readonly LightClientHead[]
  readonly gates: Readonly<Record<ChainSide, GateStatus>>
  /** Transfers and messages that are sent and not yet delivered. */
  readonly inFlight: number
  readonly volume24h: {
    readonly transferCount: number
    readonly byToken: readonly TokenAmount[]
  }
  /**
   * Figures that the RPC data source could not complete, because it reads only recent history. Absent for the indexer,
   * which holds the whole history. A figure named here is a lower bound or may miss older rows.
   */
  readonly partial?: readonly PartialFigure[]
}

/** A row of the feed: a token transfer or a message. */
export interface FeedItem {
  /** The message identifier. */
  readonly id: Hex
  readonly kind: FeedKind
  readonly direction: Direction
  readonly status: FeedStatus
  readonly sender: Address
  /** The recipient of a token transfer, or the executor contract of a message. */
  readonly recipient: Address
  /** Present for a token transfer. */
  readonly token: TokenInfo | null
  /** The amount that the mediator locked or burned, in base units. Present for a token transfer. */
  readonly amount: bigint | null
  /** Unix seconds of the send on the source chain. */
  readonly sentAt: number
  /** Unix seconds of the delivery on the destination chain, or null while pending. */
  readonly deliveredAt: number | null
  readonly sourceTransactionHash: Hex
  readonly destinationTransactionHash: Hex | null
}

/** The time ranges that the feed header offers. */
export type TimeRange = 'all' | '1h' | '24h' | '7d'

/** The filters of the feed. An absent key means no filter on that key. */
export interface FeedFilter {
  readonly direction?: Direction
  readonly kind?: FeedKind
  readonly status?: FeedStatus
  readonly token?: Address
  /** Matches the sender or the recipient. */
  readonly address?: Address
  /** Only rows sent at or after this time, in unix seconds. */
  readonly sentAtOrAfter?: number
}

/** One token of the audit view: what the mediator holds against what exists on the other chain. */
export interface AuditRow {
  /** The native token, on its home chain. */
  readonly token: TokenInfo
  /** The balance that the home mediator owes the other chain (`mediatorBalance`). */
  readonly escrow: bigint
  /** The total supply of the bridged copy on the other chain. */
  readonly bridgedSupply: bigint
  /** Amounts sent and not yet delivered. */
  readonly inFlight: bigint
  /**
   * True when the RPC data source built `inFlight` from recent history only. The difference of such a row is not proof
   * of a mismatch, because an older transfer in flight is missing from `inFlight`.
   */
  readonly partial?: boolean
}

/** The gas that one light client update used. */
export interface UpdateGasRecord {
  /** The chain that holds the light client. */
  readonly side: ChainSide
  readonly slot: bigint
  readonly gasUsed: bigint
  /** `gasUsed * effectiveGasPrice` in wei of the coin of that chain. */
  readonly costWei: bigint
  readonly transactionHash: Hex
  readonly poster: Address
  readonly at: number
}

/**
 * The prover and costs view. It holds on-chain facts only: the light client head updates. Off-chain proof timing and
 * GPU host cost are not in the indexer. A later data source may add them as new fields.
 */
export interface ProverReport {
  readonly updates: readonly UpdateGasRecord[]
}
