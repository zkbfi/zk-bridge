import { describe, expect, test } from 'bun:test'
import { tokenMediatorAbi } from '@zk-bridge/shared'
import { erc20Abi, type Address } from 'viem'
import { readChainSnapshot, readRouterAddresses, type ReadClient } from '../../src/chain/live-reads'
import { FIXTURE_PAIR, FIXTURE_TOKENS } from '../../src/data/fixtures'

const account: Address = '0x00000000000000000000000000000000000000a9'
const chain = FIXTURE_PAIR.first
const mediator = chain.contracts.tokenMediator
const firstSideTokens = FIXTURE_TOKENS.filter((token) => token.side === 'first')
const [usdcFirst, wethFirst] = [firstSideTokens[0]!, firstSideTokens[1]!]
const usdcSecond = FIXTURE_TOKENS.find((token) => token.side === 'second')!

interface Call {
  readonly address: Address
  readonly functionName: string
  readonly args: readonly unknown[] | undefined
}

/** A client that answers each contract read from a function and records every call. */
function recordingClient(answer: (call: Call) => unknown, balance: bigint | Error = 5n): ReadClient & { readonly calls: Call[]; readonly balanceQueries: Address[] } {
  const calls: Call[] = []
  const balanceQueries: Address[] = []
  return {
    calls,
    balanceQueries,
    async getBalance({ address }) {
      balanceQueries.push(address)
      if (balance instanceof Error) throw balance
      return balance
    },
    async readContract(parameters) {
      const call = { address: parameters.address, functionName: parameters.functionName, args: parameters.args }
      calls.push(call)
      return answer(call)
    },
  }
}

describe('readChainSnapshot', () => {
  test('reads the balance and the two amounts of each token of its own chain, from the right contracts', async () => {
    const answers: Record<string, unknown> = {
      balanceOf: 11n,
      allowance: 22n,
      nativeTokenAddress: '0x0000000000000000000000000000000000000000',
      isBridgedTokenDeployAcknowledged: true,
    }
    const client = recordingClient((call) => answers[call.functionName], 777n)
    const result = await readChainSnapshot(client, { chain, account, tokens: FIXTURE_TOKENS })
    expect(result).toEqual({
      status: 'ok',
      snapshot: {
        chain,
        nativeBalance: 777n,
        positions: [
          { token: usdcFirst, balance: 11n, allowance: 22n, relayGas: { kind: 'acknowledged' } },
          { token: wethFirst, balance: 11n, allowance: 22n, relayGas: { kind: 'acknowledged' } },
          { token: firstSideTokens[2]!, balance: 11n, allowance: 22n, relayGas: { kind: 'acknowledged' } },
        ],
      },
    })
    expect(client.balanceQueries).toEqual([account])
    // Tokens of the other chain are not read.
    expect(client.calls.some((call) => call.address === usdcSecond.address)).toBe(false)
    expect(client.calls.some((call) => call.functionName === 'currentFeeRate')).toBe(false)
    expect(client.calls).toContainEqual({ address: usdcFirst.address, functionName: 'balanceOf', args: [account] })
    expect(client.calls).toContainEqual({ address: usdcFirst.address, functionName: 'allowance', args: [account, mediator] })
    expect(client.calls.some((call) => call.functionName === 'claimable')).toBe(false)
    expect(client.calls).toContainEqual({ address: mediator, functionName: 'nativeTokenAddress', args: [usdcFirst.address] })
    expect(client.calls).toContainEqual({ address: mediator, functionName: 'isBridgedTokenDeployAcknowledged', args: [usdcFirst.address] })
    expect(client.calls).toHaveLength(3 * 4)
  })

  test('sends each read with the abi of its contract, so a wrong abi cannot pass', async () => {
    const abis: unknown[] = []
    const client: ReadClient = {
      async getBalance() {
        return 0n
      },
      async readContract(parameters) {
        abis.push(parameters.abi)
        return 0n
      },
    }
    await readChainSnapshot(client, { chain, account, tokens: [usdcFirst] })
    expect(abis).toEqual([erc20Abi, erc20Abi, tokenMediatorAbi])
  })

  test('a native token with no proof yet is read as a deploy, with the length of its name and symbol', async () => {
    const answers: Record<string, unknown> = {
      balanceOf: 1n,
      allowance: 1n,
      nativeTokenAddress: '0x0000000000000000000000000000000000000000',
      isBridgedTokenDeployAcknowledged: false,
      name: 'Token',
      symbol: 'TKN',
    }
    const result = await readChainSnapshot(recordingClient((call) => answers[call.functionName]), { chain, account, tokens: [usdcFirst] })
    expect(result).toMatchObject({ snapshot: { positions: [{ relayGas: { kind: 'unacknowledged', nameAndSymbolBytes: 8 } }] } })
  })

  test('a bridged copy is read as a release', async () => {
    const answers: Record<string, unknown> = { balanceOf: 1n, allowance: 1n, nativeTokenAddress: usdcSecond.address }
    const result = await readChainSnapshot(recordingClient((call) => answers[call.functionName]), { chain, account, tokens: [usdcFirst] })
    expect(result).toMatchObject({ snapshot: { positions: [{ relayGas: { kind: 'copy' } }] } })
  })

  test('a chain with no token still reads the balance', async () => {
    const result = await readChainSnapshot(recordingClient(() => 9n), { chain, account, tokens: [usdcSecond] })
    expect(result).toEqual({ status: 'ok', snapshot: { chain, nativeBalance: 5n, positions: [] } })
  })

  test('an answer that is not an integer becomes an error result that names the function', async () => {
    const result = await readChainSnapshot(recordingClient(() => '12'), { chain, account, tokens: [usdcFirst] })
    expect(result).toEqual({ status: 'error', chain, message: 'balanceOf did not return an integer' })
  })

  test('a failed read becomes an error result with the message, and one that is not an Error becomes text', async () => {
    const failing = await readChainSnapshot(recordingClient(() => 1n, new Error('node down')), { chain, account, tokens: [] })
    expect(failing).toEqual({ status: 'error', chain, message: 'node down' })
    const client = recordingClient(() => 1n)
    const thrower: ReadClient = {
      getBalance: client.getBalance,
      async readContract() {
        throw 'plain text failure'
      },
    }
    expect(await readChainSnapshot(thrower, { chain, account, tokens: [usdcFirst] })).toEqual({ status: 'error', chain, message: 'plain text failure' })
  })
})

describe('readRouterAddresses with a failure that is not an Error', () => {
  test('keeps the text of the failure as the reason', async () => {
    const client: ReadClient = {
      async getBalance() {
        return 0n
      },
      async readContract() {
        throw 'bare text'
      },
    }
    expect(await readRouterAddresses(client, { router: '0x00000000000000000000000000000000000000a2' })).toEqual({ kind: 'unreadable', reason: 'bare text' })
  })
})
