import { describe, expect, test } from 'bun:test'
import { FIXTURE_ACCOUNT, FIXTURE_PAIR, FIXTURE_TOKENS } from '../../src/data/fixtures'
import { planApproval } from '../../src/tx/plan'
import { applyFormKey, createFormState, type FieldSpec, type FormKey } from '../../src/ui/form'
import { reviewLines, wrapHexLines } from '../../src/ui/review-lines'
import { lineText } from '../../src/ui/rich-text'

const key = (name: string, sequence = name): FormKey => ({ name, sequence, ctrl: false, shift: false, meta: false, option: false })

describe('wrapHexLines', () => {
  test('cuts the text into lines of the width and keeps every character in order', () => {
    const lines = wrapHexLines('0x0123456789', 4).map(lineText)
    expect(lines).toEqual(['0x01', '2345', '6789'])
  })

  test('gives no line for an empty text', () => {
    expect(wrapHexLines('', 4)).toEqual([])
  })
})

describe('the full calldata view of the review', () => {
  const usdc = FIXTURE_TOKENS[0]!
  const plan = planApproval({ chain: FIXTURE_PAIR.first, token: usdc, spender: FIXTURE_PAIR.first.contracts.tokenMediator, spenderLabel: 'TokenMediator', amount: 25n })
  const prepared = {
    plan,
    from: FIXTURE_ACCOUNT,
    unsigned: { type: 'eip1559' as const, chainId: 1, nonce: 1, to: plan.to, data: plan.data, value: 0n, gas: 1n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n },
    gasEstimate: 1n,
    gasLimit: 1n,
    maximumNetworkFee: 1n,
  }
  const bytes = (plan.data.length - 2) / 2

  test('lists the byte count, then every byte of the data wrapped to the width', () => {
    const text = reviewLines(prepared, { position: null, calldata: 'full', wrapWidth: 40 }).map(lineText)
    const start = text.indexOf(`Calldata (${bytes} bytes)`)
    expect(start).toBeGreaterThan(0)
    expect(text.slice(start + 1).join('')).toBe(plan.data)
    expect(text.slice(start + 1).every((line) => line.length <= 40)).toBe(true)
    expect(text.join('\n')).not.toContain('press d for every byte')
  })

  test('the summary shows the digest and the hint instead', () => {
    const text = reviewLines(prepared, { position: null, calldata: 'summary', wrapWidth: 40 }).map(lineText).join('\n')
    expect(text).toContain(`${bytes} bytes, keccak256 0x`)
    expect(text).toContain('press d for every byte')
  })
})

describe('a key that a choice field does not use', () => {
  const specs: readonly FieldSpec[] = [{ kind: 'choice', name: 'mode', label: 'Mode', choices: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] }]

  test('changes nothing and reports the key as ignored', () => {
    const state = createFormState(specs)
    const result = applyFormKey(specs, state, key('x'))
    expect(result.outcome).toBe('ignored')
    expect(result.state).toEqual(state)
  })
})
