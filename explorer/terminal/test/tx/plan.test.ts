import { describe, expect, test } from 'bun:test'
import { FIXTURE_PAIR, FIXTURE_TOKENS } from '../../src/data/fixtures'
import {
  PlanInputError,
  parseAddress,
  parseHexBytes,
  planApproval,
  planClaim,
  planRelay,
  planSendMessage,
  planWrapAndRelay,
} from '../../src/tx/plan'
import { decodeKnownCall } from '../../src/tx/decode'

// The expected calldata below was produced by Foundry `cast calldata`, an independent encoder, for these inputs:
// token 0x...1001 (USDC, 6 decimals), receiver 0x...0abc, fallback 0x...0abd, 2.5 tokens (2500000 base units).
const usdc = FIXTURE_TOKENS[0]!
const chain = FIXTURE_PAIR.first
const receiver = '0x0000000000000000000000000000000000000abc'
const fallbackRecipient = '0x0000000000000000000000000000000000000abd'
const AMOUNT = 2_500_000n

const EXPECTED = {
  relay:
    '0xad58bdd100000000000000000000000000000000000000000000000000000000000010010000000000000000000000000000000000000000000000000000000000000abc00000000000000000000000000000000000000000000000000000000002625a0',
  call: '0xd740548100000000000000000000000000000000000000000000000000000000000010010000000000000000000000000000000000000000000000000000000000000abc00000000000000000000000000000000000000000000000000000000002625a000000000000000000000000000000000000000000000000000000000000000800000000000000000000000000000000000000000000000000000000000000004deadbeef00000000000000000000000000000000000000000000000000000000',
  fallbackFive:
    '0xddbf52bc00000000000000000000000000000000000000000000000000000000000010010000000000000000000000000000000000000000000000000000000000000abc00000000000000000000000000000000000000000000000000000000002625a000000000000000000000000000000000000000000000000000000000000000a00000000000000000000000000000000000000000000000000000000000000abd0000000000000000000000000000000000000000000000000000000000000000',
  claim:
    '0x21c0b34200000000000000000000000000000000000000000000000000000000000010010000000000000000000000000000000000000000000000000000000000000abc',
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

  test('fallback uses the five-argument form', () => {
    const plan = planRelay({
      chain,
      token: usdc,
      receiver,
      amount: AMOUNT,
      mode: { kind: 'fallback', data: '0x', fallbackRecipient },
    })
    expect(plan.data).toBe(EXPECTED.fallbackFive as `0x${string}`)
    expect(plan.arguments.map((argument) => argument.name)).not.toContain('maxFeeRate')
  })

  test('the mediator takes no fee: the plan names the whole amount and carries no fee note', () => {
    const plan = planRelay({ chain, token: usdc, receiver, amount: 1_999_999n, mode: { kind: 'plain' } })
    expect(plan.arguments.find((argument) => argument.name === 'value')?.value).toBe('1999999')
    expect(plan.notes).toEqual(['If the receiver cannot be paid there, the release goes to the sender at the same address.'])
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

  test('claim refuses an empty claimable balance and encodes claim(token, account)', () => {
    expect(() => planClaim({ chain, token: usdc, account: receiver, claimable: 0n })).toThrow(PlanInputError)
    const plan = planClaim({ chain, token: usdc, account: receiver, claimable: 25_000_000n })
    expect(plan.data).toBe(EXPECTED.claim as `0x${string}`)
    expect(plan.notes[0]).toContain('25 USDC')
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
