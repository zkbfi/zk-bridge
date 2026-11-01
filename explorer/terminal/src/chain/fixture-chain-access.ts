/**
 * Chain access with no network. It answers reads from memory and accepts sends without reaching any chain.
 * The dashboard shows a banner in this mode, so nobody mistakes a fixture send for a real one.
 */
import type { Address, Hash } from 'viem'
import type { FlowChainClient } from '../flow/transaction-flow'
import type { PairConfig, TokenInfo } from '../model/types'
import { FIXTURE_TRANSACTION_HASH, type ChainAccess } from './chain-access'
import type { ChainSnapshotResult, RouterAddressesReading } from './live-reads'

/** The numbers that the fixture chains report. */
export interface FixtureChainNumbers {
  /** The allowance the account has given the mediator, in base units. Default: zero. */
  readonly allowance: bigint
  /** The gas estimate for every call. Default: 150,000. */
  readonly gasEstimate: bigint
  /** What every delivery router answers to `rewardAddress()` and `failedDeliveryAddress()`. Default: two fixed sample addresses. */
  readonly routerAddresses: RouterAddressesReading
}

const DEFAULT_NUMBERS: FixtureChainNumbers = {
  allowance: 0n,
  gasEstimate: 150_000n,
  routerAddresses: {
    kind: 'read',
    rewardAddress: '0x00000000000000000000000000000000000000Ab',
    failedDeliveryAddress: '0x00000000000000000000000000000000000000Cd',
  },
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
          positions: tokens
            .filter((token) => token.side === chain.side)
            .map((token, index) => ({
              token,
              balance: BigInt(1_000 * (index + 1)) * 10n ** BigInt(token.decimals),
              allowance: settings.allowance,
            })),
        },
      }))
    },
    async nativeBalances(addresses) {
      return addresses.map((_, index) => ({ first: BigInt(index + 1) * 10n ** 18n, second: BigInt(index) * 10n ** 21n }))
    },
    async readRouterAddresses() {
      return settings.routerAddresses
    },
    flowClient: () => flowClient,
  }
}
