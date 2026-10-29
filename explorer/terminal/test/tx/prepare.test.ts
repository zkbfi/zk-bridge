import { describe, expect, test } from 'bun:test'
import { FIXTURE_PAIR } from '../../src/data/fixtures'
import type { PlannedTransaction } from '../../src/tx/plan'
import { prepareTransaction, type PrepareClient } from '../../src/tx/prepare'

const FROM = '0x00000000000000000000000000000000000000f1'

function planOn(chainId: number): PlannedTransaction {
  return {
    title: 'test',
    chain: { ...FIXTURE_PAIR.first, chainId },
    to: '0x0000000000000000000000000000000000000abc',
    contractLabel: 'test',
    functionSignature: 'unknown',
    functionName: 'unknown',
    data: '0x',
    value: 0n,
    arguments: [],
    notes: [],
  } as PlannedTransaction
}

function clientSuggesting(fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }): PrepareClient {
  return {
    async estimateGas() {
      return 100_000n
    },
    async getTransactionCount() {
      return 7
    },
    async estimateFeesPerGas() {
      return fees
    },
  }
}

describe('the priority fee of a prepared transaction', () => {
  test('raises a tip of 1 wei to 0.01 gwei on PulseChain testnet v4, and the fee cap by the same amount', async () => {
    const prepared = await prepareTransaction(clientSuggesting({ maxFeePerGas: 15n, maxPriorityFeePerGas: 1n }), FROM, planOn(943))
    expect(prepared.unsigned.maxPriorityFeePerGas).toBe(10_000_000n)
    expect(prepared.unsigned.maxFeePerGas).toBe(15n + 9_999_999n)
    expect(prepared.maximumNetworkFee).toBe(prepared.gasLimit * (15n + 9_999_999n))
  })

  test('raises a small tip on PulseChain as well', async () => {
    const prepared = await prepareTransaction(clientSuggesting({ maxFeePerGas: 2_000_000n, maxPriorityFeePerGas: 1_000_000n }), FROM, planOn(369))
    expect(prepared.unsigned.maxPriorityFeePerGas).toBe(10_000_000n)
  })

  test('keeps the suggested fees on a chain without a minimum, and a tip that is already high enough', async () => {
    const low = await prepareTransaction(clientSuggesting({ maxFeePerGas: 15n, maxPriorityFeePerGas: 1n }), FROM, planOn(1))
    expect(low.unsigned).toMatchObject({ maxFeePerGas: 15n, maxPriorityFeePerGas: 1n })
    const high = await prepareTransaction(clientSuggesting({ maxFeePerGas: 3_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n }), FROM, planOn(943))
    expect(high.unsigned).toMatchObject({ maxFeePerGas: 3_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n })
  })
})
