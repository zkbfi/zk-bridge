/**
 * Chain access with no network. It answers reads from memory and accepts sends without reaching any chain.
 * The dashboard shows a banner in this mode, so nobody mistakes a fixture send for a real one.
 */
import type { Address, Hash } from 'viem'
import type { FlowChainClient } from '../flow/transaction-flow'
import type { PairConfig, TokenInfo } from '../model/types'
import { FIXTURE_TRANSACTION_HASH, type ChainAccess } from './chain-access'
import type { ChainSnapshotResult } from './live-reads'

/** The numbers that the fixture chains report. */
export interface FixtureChainNumbers {
  /** The fee rate of the mediator, 1e18-scaled. Default: 0.1 percent. */
  readonly feeRate: bigint
  /** The fee ceiling, 1e18-scaled. Default: 1 percent. */
  readonly feeCeiling: bigint
  /** The allowance the account has given the mediator, in base units. Default: zero. */
  readonly allowance: bigint
  /** The gas estimate for every call. Default: 150,000. */
  readonly gasEstimate: bigint
}

const DEFAULT_NUMBERS: FixtureChainNumbers = {
  feeRate: 10n ** 15n,
  feeCeiling: 10n ** 16n,
  allowance: 0n,
  gasEstimate: 150_000n,
}

/** Creates chain access over memory. */
export function createFixtureChainAccess(
  pair: PairConfig,
  numbers: Partial<FixtureChainNumbers> = {},
): ChainAccess & { readonly sentTransactions: readonly Hash[] } {
  const settings = { ...DEFAULT_NUMBERS, ...numbers }
  const sentTransactions: Hash[] = []
  const flowClient: FlowChainClient = {
    async estimateGas() {
      return settings.gasEstimate
    },
    async getTransactionCount() {
      return 7
    },
    async estimateFeesPerGas() {
      return { maxFeePerGas: 30_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n }
    },
    async sendRawTransaction() {
      sentTransactions.push(FIXTURE_TRANSACTION_HASH)
      return FIXTURE_TRANSACTION_HASH
    },
    async waitForTransactionReceipt({ hash }) {
      return { status: 'success', gasUsed: settings.gasEstimate, blockNumber: 1_000n, transactionHash: hash } as never
    },
  }
  return {
    mode: 'fixture',
    sentTransactions,
    async readSnapshots({ tokens }: { account: Address; tokens: readonly TokenInfo[] }) {
      return [pair.first, pair.second].map((chain): ChainSnapshotResult => ({
        status: 'ok',
        snapshot: {
          chain,
          nativeBalance: 12n * 10n ** 18n,
          feeRate: settings.feeRate,
          feeCeiling: settings.feeCeiling,
          positions: tokens
            .filter((token) => token.side === chain.side)
            .map((token, index) => ({
              token,
              balance: BigInt(1_000 * (index + 1)) * 10n ** BigInt(token.decimals),
              allowance: settings.allowance,
              claimable: token.symbol === 'USDC' ? 25n * 10n ** 6n : 0n,
            })),
        },
      }))
    },
    async nativeBalances(addresses) {
      return addresses.map((_, index) => ({ first: BigInt(index + 1) * 10n ** 18n, second: BigInt(index) * 10n ** 21n }))
    },
    flowClient: () => flowClient,
  }
}
