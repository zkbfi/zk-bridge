import { describe, expect, test } from 'bun:test'
import type { RelayGasFacts } from '@zk-bridge/shared'
import { FIXTURE_PAIR, FIXTURE_TOKENS } from '../../src/data/fixtures'
import {
  PlanInputError,
  parseAddress,
  parseHexBytes,
  planApproval,
  planRelay,
  planSendMessage,
  planWrapAndRelay,
} from '../../src/tx/plan'
import { decodeKnownCall } from '../../src/tx/decode'

// The expected calldata below was produced by Foundry `cast calldata`, an independent encoder, for these inputs:
// token 0x...1001 (USDC, 6 decimals), receiver 0x...0abc, 2.5 tokens (2500000 base units), gas limit 300000.
const usdc = FIXTURE_TOKENS[0]!
const chain = FIXTURE_PAIR.first
const receiver = '0x0000000000000000000000000000000000000abc'
const AMOUNT = 2_500_000n

const EXPECTED = {
  relay:
    '0xad58bdd100000000000000000000000000000000000000000000000000000000000010010000000000000000000000000000000000000000000000000000000000000abc00000000000000000000000000000000000000000000000000000000002625a0',
  call: '0xd740548100000000000000000000000000000000000000000000000000000000000010010000000000000000000000000000000000000000000000000000000000000abc00000000000000000000000000000000000000000000000000000000002625a000000000000000000000000000000000000000000000000000000000000000800000000000000000000000000000000000000000000000000000000000000004deadbeef00000000000000000000000000000000000000000000000000000000',
  relayWithGasLimit:
    '0xba4636d600000000000000000000000000000000000000000000000000000000000010010000000000000000000000000000000000000000000000000000000000000abc00000000000000000000000000000000000000000000000000000000002625a000000000000000000000000000000000000000000000000000000000000493e0',
  callWithGasLimit:
    '0x9223413400000000000000000000000000000000000000000000000000000000000010010000000000000000000000000000000000000000000000000000000000000abc00000000000000000000000000000000000000000000000000000000002625a000000000000000000000000000000000000000000000000000000000000000a000000000000000000000000000000000000000000000000000000000000f42400000000000000000000000000000000000000000000000000000000000000004deadbeef00000000000000000000000000000000000000000000000000000000',
  pass: '0xdc8601b30000000000000000000000000000000000000000000000000000000000000abc00000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000030d4000000000000000000000000000000000000000000000000000000000000000021234000000000000000000000000000000000000000000000000000000000000',
  wrap: '0xf52cbf0e0000000000000000000000000000000000000000000000000000000000000abc',
  approve:
    '0x095ea7b300000000000000000000000000000000000000000000000000000000000000a100000000000000000000000000000000000000000000000000000000002625a0',
}

describe('planRelay', () => {
  test('plain relay encodes relayTokens(token, receiver, value) and targets the mediator', () => {
    const plan = planRelay({ chain, token: usdc, receiver, amount: AMOUNT, mode: { kind: 'plain' } })
    expect(plan.data).toBe(EXPECTED.relay as `0x${string}`)
    expect(plan.to).toBe(chain.contracts.tokenMediator)
    expect(plan.functionSignature).toBe('relayTokens(address,address,uint256)')
    expect(plan.value).toBe(0n)
  })

  test('relay and call encodes the data as bytes', () => {
    const plan = planRelay({
      chain,
      token: usdc,
      receiver,
      amount: AMOUNT,
      mode: { kind: 'call', data: '0xdeadbeef' },
    })
    expect(plan.data).toBe(EXPECTED.call as `0x${string}`)
    expect(plan.functionName).toBe('relayTokensAndCall')
  })

  test('a plain relay with a gas limit plans the four-argument overload', () => {
    const plan = planRelay({ chain, token: usdc, receiver, amount: AMOUNT, mode: { kind: 'plain' }, gasLimit: 300_000n })
    expect(plan.data).toBe(EXPECTED.relayWithGasLimit as `0x${string}`)
    expect(plan.functionSignature).toBe('relayTokens(address,address,uint256,uint256)')
    expect(plan.arguments.map((argument) => argument.name)).toEqual(['token', 'receiver', 'value', 'gasLimit'])
    expect(plan.arguments.find((argument) => argument.name === 'gasLimit')?.value).toBe('300000')
  })

  test('a call relay with a gas limit plans the five-argument overload', () => {
    const plan = planRelay({ chain, token: usdc, receiver, amount: AMOUNT, mode: { kind: 'call', data: '0xdeadbeef' }, gasLimit: 1_000_000n })
    expect(plan.data).toBe(EXPECTED.callWithGasLimit as `0x${string}`)
    expect(plan.functionSignature).toBe('relayTokensAndCall(address,address,uint256,bytes,uint256)')
    expect(plan.arguments.map((argument) => argument.name)).toEqual(['token', 'receiver', 'value', 'data', 'gasLimit'])
  })

  test('without a gas limit the plan keeps the old function', () => {
    const plain = planRelay({ chain, token: usdc, receiver, amount: AMOUNT, mode: { kind: 'plain' } })
    const call = planRelay({ chain, token: usdc, receiver, amount: AMOUNT, mode: { kind: 'call', data: '0xdeadbeef' } })
    expect(plain.data).toBe(EXPECTED.relay as `0x${string}`)
    expect(call.data).toBe(EXPECTED.call as `0x${string}`)
  })

  test('refuses a gas limit of zero', () => {
    expect(() => planRelay({ chain, token: usdc, receiver, amount: AMOUNT, mode: { kind: 'plain' }, gasLimit: 0n })).toThrow(PlanInputError)
  })

  test('plan refuses a gas limit below the default of the kind', () => {
    const plainBelow = () => planRelay({ chain, token: usdc, receiver, amount: AMOUNT, mode: { kind: 'plain' }, gasLimit: 249_999n })
    const callBelow = () => planRelay({ chain, token: usdc, receiver, amount: AMOUNT, mode: { kind: 'call', data: '0xdeadbeef' }, gasLimit: 999_999n })
    expect(plainBelow).toThrow(PlanInputError)
    expect(plainBelow).toThrow(/at least 250000/)
    expect(callBelow).toThrow(/at least 1000000/)
    const atDefault = planRelay({ chain, token: usdc, receiver, amount: AMOUNT, mode: { kind: 'plain' }, gasLimit: 250_000n })
    expect(atDefault.arguments.find((argument) => argument.name === 'gasLimit')?.value).toBe('250000')
  })

  test('plan refuses a gas limit above the bridge maximum', () => {
    const above = () => planRelay({ chain, token: usdc, receiver, amount: AMOUNT, mode: { kind: 'plain' }, gasLimit: 10_000_001n })
    expect(above).toThrow(/at most 10000000/)
    const atMaximum = planRelay({ chain, token: usdc, receiver, amount: AMOUNT, mode: { kind: 'plain' }, gasLimit: 10_000_000n })
    expect(atMaximum.arguments.find((argument) => argument.name === 'gasLimit')?.value).toBe('10000000')
  })

  test('plan names the deploy minimum for a native token with no proof, and uses the name and symbol length', () => {
    const relay = (relayGas: RelayGasFacts, gasLimit: bigint) => () => planRelay({ chain, token: usdc, receiver, amount: AMOUNT, mode: { kind: 'plain' }, gasLimit, relayGas })
    expect(relay({ kind: 'unacknowledged', nameAndSymbolBytes: 8 }, 300_000n)).toThrow(/at least 2000000/)
    expect(relay({ kind: 'unacknowledged', nameAndSymbolBytes: 500 }, 2_000_000n)).toThrow(/at least 2100000/)
    expect(relay({ kind: 'unacknowledged', nameAndSymbolBytes: 500 }, 2_100_000n)).not.toThrow()
    expect(relay({ kind: 'acknowledged' }, 300_000n)).not.toThrow()
    expect(relay({ kind: 'copy' }, 249_999n)).toThrow(/at least 250000/)
  })

  test('the gas limit plan decodes back to its arguments', () => {
    const plan = planRelay({ chain, token: usdc, receiver, amount: AMOUNT, mode: { kind: 'plain' }, gasLimit: 300_000n })
    expect(decodeKnownCall(plan.data)?.arguments.map((argument) => argument.value).at(-1)).toBe('300000')
  })

  test('the mediator takes no fee: the plan names the whole amount and carries no fee note', () => {
    const plan = planRelay({ chain, token: usdc, receiver, amount: 1_999_999n, mode: { kind: 'plain' } })
    expect(plan.arguments.find((argument) => argument.name === 'value')?.value).toBe('1999999')
    expect(plan.notes).toEqual(['If the receiver cannot take the release there, the release is final: the tokens stay in the mediator and nobody can claim them. Check the receiver first.'])
    expect(plan).not.toHaveProperty('charge')
  })

  test('refuses a zero amount and a receiver that is not an address', () => {
    expect(() => planRelay({ chain, token: usdc, receiver, amount: 0n, mode: { kind: 'plain' } })).toThrow(PlanInputError)
    expect(() => planRelay({ chain, token: usdc, receiver: '0x12', amount: 1n, mode: { kind: 'plain' } })).toThrow(PlanInputError)
  })

  test('every plan decodes back to the arguments that went in', () => {
    const plan = planRelay({ chain, token: usdc, receiver, amount: AMOUNT, mode: { kind: 'plain' } })
    const decoded = decodeKnownCall(plan.data)
    expect(decoded?.functionName).toBe('relayTokens')
    expect(decoded?.arguments.map((argument) => argument.value)).toEqual([
      usdc.address,
      '0x0000000000000000000000000000000000000aBc',
      '2500000',
    ])
  })
})

describe('other plans', () => {
  test('approval is for the exact amount and names the mediator as spender', () => {
    const plan = planApproval({ chain, token: usdc, spender: chain.contracts.tokenMediator, spenderLabel: 'TokenMediator', amount: AMOUNT })
    expect(plan.data).toBe(EXPECTED.approve as `0x${string}`)
    expect(plan.to).toBe(usdc.address)
    expect(plan.notes[0]).toContain('not an unlimited allowance')
  })

  test('send message encodes requireToPassMessage on the message bridge', () => {
    const plan = planSendMessage({ chain, target: receiver, data: '0x1234', gas: 200_000n })
    expect(plan.data).toBe(EXPECTED.pass as `0x${string}`)
    expect(plan.to).toBe(chain.contracts.messageBridge)
  })

  test('wrap and relay sends the coin as the call value to the delivery router', () => {
    const plan = planWrapAndRelay({ chain, receiver, value: 10n ** 18n })
    expect(plan.data).toBe(EXPECTED.wrap as `0x${string}`)
    expect(plan.value).toBe(10n ** 18n)
    expect(plan.to).toBe(chain.contracts.deliveryRouter!)
    expect(plan.contractLabel).toBe('DeliveryRouter')
    expect(() => planWrapAndRelay({ chain: { ...chain, contracts: { ...chain.contracts, deliveryRouter: null } }, receiver, value: 1n })).toThrow(PlanInputError)
  })
})

describe('input parsing', () => {
  test('parseAddress returns the checksummed form and refuses text that is not an address', () => {
    expect(parseAddress('0x0000000000000000000000000000000000000abc', 'receiver')).toBe('0x0000000000000000000000000000000000000aBc')
    expect(() => parseAddress('0xabc', 'receiver')).toThrow(PlanInputError)
    expect(() => parseAddress('', 'receiver')).toThrow(PlanInputError)
  })

  test('parseHexBytes accepts empty input, even hex, and refuses odd or non-hex text', () => {
    expect(parseHexBytes('')).toBe('0x')
    expect(parseHexBytes(' 0x ')).toBe('0x')
    expect(parseHexBytes('0xAbCd')).toBe('0xAbCd')
    expect(() => parseHexBytes('0xabc')).toThrow(PlanInputError)
    expect(() => parseHexBytes('hello')).toThrow(PlanInputError)
  })
})
