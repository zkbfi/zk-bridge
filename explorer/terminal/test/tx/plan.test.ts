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
const ZERO_FEE = 0n

const EXPECTED = {
  relay:
    '0xad58bdd100000000000000000000000000000000000000000000000000000000000010010000000000000000000000000000000000000000000000000000000000000abc00000000000000000000000000000000000000000000000000000000002625a0',
  call: '0xd740548100000000000000000000000000000000000000000000000000000000000010010000000000000000000000000000000000000000000000000000000000000abc00000000000000000000000000000000000000000000000000000000002625a000000000000000000000000000000000000000000000000000000000000000800000000000000000000000000000000000000000000000000000000000000004deadbeef00000000000000000000000000000000000000000000000000000000',
  fallbackFive:
    '0xddbf52bc00000000000000000000000000000000000000000000000000000000000010010000000000000000000000000000000000000000000000000000000000000abc00000000000000000000000000000000000000000000000000000000002625a000000000000000000000000000000000000000000000000000000000000000a00000000000000000000000000000000000000000000000000000000000000abd0000000000000000000000000000000000000000000000000000000000000000',
  fallbackSix:
    '0x3f0c752d00000000000000000000000000000000000000000000000000000000000010010000000000000000000000000000000000000000000000000000000000000abc00000000000000000000000000000000000000000000000000000000002625a000000000000000000000000000000000000000000000000000000000000000c00000000000000000000000000000000000000000000000000000000000000abd000000000000000000000000000000000000000000000000000aa87bee5380000000000000000000000000000000000000000000000000000000000000000002cafe000000000000000000000000000000000000000000000000000000000000',
  claim:
    '0x21c0b34200000000000000000000000000000000000000000000000000000000000010010000000000000000000000000000000000000000000000000000000000000abc',
  pass: '0xdc8601b30000000000000000000000000000000000000000000000000000000000000abc00000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000030d4000000000000000000000000000000000000000000000000000000000000000021234000000000000000000000000000000000000000000000000000000000000',
  wrap: '0xf52cbf0e0000000000000000000000000000000000000000000000000000000000000abc',
  approve:
    '0x095ea7b300000000000000000000000000000000000000000000000000000000000000a100000000000000000000000000000000000000000000000000000000002625a0',
}

describe('planRelay', () => {
  test('plain relay encodes relayTokens(token, receiver, value) and targets the mediator', () => {
    const plan = planRelay({ chain, token: usdc, receiver, amount: AMOUNT, mode: { kind: 'plain' }, currentFeeRate: ZERO_FEE })
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
      currentFeeRate: ZERO_FEE,
    })
    expect(plan.data).toBe(EXPECTED.call as `0x${string}`)
    expect(plan.functionName).toBe('relayTokensAndCall')
  })

  test('fallback without a limit uses the five-argument form', () => {
    const plan = planRelay({
      chain,
      token: usdc,
      receiver,
      amount: AMOUNT,
      mode: { kind: 'fallback', data: '0x', fallbackRecipient },
      currentFeeRate: ZERO_FEE,
    })
    expect(plan.data).toBe(EXPECTED.fallbackFive as `0x${string}`)
    expect(plan.arguments.map((argument) => argument.name)).not.toContain('maxFeeRate')
  })

  test('fallback with a limit uses the six-argument form and shows the limit as an exact percentage', () => {
    const plan = planRelay({
      chain,
      token: usdc,
      receiver,
      amount: AMOUNT,
      mode: { kind: 'fallback', data: '0xcafe', fallbackRecipient, maxFeeRate: 3n * 10n ** 15n },
      currentFeeRate: 10n ** 15n,
    })
    expect(plan.data).toBe(EXPECTED.fallbackSix as `0x${string}`)
    const limit = plan.arguments.find((argument) => argument.name === 'maxFeeRate')
    expect(limit?.value).toBe('3000000000000000')
    expect(limit?.meaning).toBe('0.3%')
  })

  test('refuses a fee limit below the current rate, which the contract would revert', () => {
    expect(() =>
      planRelay({
        chain,
        token: usdc,
        receiver,
        amount: AMOUNT,
        mode: { kind: 'fallback', data: '0x', fallbackRecipient, maxFeeRate: 10n ** 14n },
        currentFeeRate: 10n ** 15n,
      }),
    ).toThrow(PlanInputError)
  })

  test('computes the fee the way the mediator does and shows what arrives', () => {
    const plan = planRelay({ chain, token: usdc, receiver, amount: 1_999_999n, mode: { kind: 'plain' }, currentFeeRate: 10n ** 15n })
    // 1999999 * 0.1% = 1999.999, which the mediator cuts to 1999.
    expect(plan.charge).toEqual({ token: usdc, rate: 10n ** 15n, amount: 1_999n })
    expect(plan.notes[0]).toContain('0.1%')
    expect(plan.notes[0]).toContain('0.001999 USDC')
    expect(plan.notes[0]).toContain('1.998 USDC')
  })

  test('refuses a zero amount and a receiver that is not an address', () => {
    expect(() => planRelay({ chain, token: usdc, receiver, amount: 0n, mode: { kind: 'plain' }, currentFeeRate: 0n })).toThrow(PlanInputError)
    expect(() => planRelay({ chain, token: usdc, receiver: '0x12', amount: 1n, mode: { kind: 'plain' }, currentFeeRate: 0n })).toThrow(PlanInputError)
  })

  test('every plan decodes back to the arguments that went in', () => {
    const plan = planRelay({ chain, token: usdc, receiver, amount: AMOUNT, mode: { kind: 'plain' }, currentFeeRate: 0n })
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

  test('wrap and relay sends the coin as the call value to the router', () => {
    const plan = planWrapAndRelay({ chain, receiver, value: 10n ** 18n })
    expect(plan.data).toBe(EXPECTED.wrap as `0x${string}`)
    expect(plan.value).toBe(10n ** 18n)
    expect(plan.to).toBe(chain.contracts.wrappedNativeRouter!)
    expect(() => planWrapAndRelay({ chain: { ...chain, contracts: { ...chain.contracts, wrappedNativeRouter: null } }, receiver, value: 1n })).toThrow(PlanInputError)
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
