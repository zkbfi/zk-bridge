import { describe, expect, test } from 'bun:test'
import { PairConfigError, buildPairConfig } from '../../src/config/pairs'

describe('buildPairConfig input guard', () => {
  test('refuses a deployment file that is not a JSON object, because it is parsed from outside', () => {
    for (const deployment of [null, 'text', 7, undefined]) {
      expect(() => buildPairConfig('eth-pls', deployment)).toThrow(new PairConfigError('The deployment file must be a JSON object.'))
    }
  })

  test('refuses an unknown pair and lists the known ones', () => {
    expect(() => buildPairConfig('nope', {})).toThrow('Unknown pair "nope". Known pairs: eth-pls.')
  })

  test('refuses a file with no section for a chain, and reports how many it found', () => {
    expect(() => buildPairConfig('eth-pls', {})).toThrow('The deployment file must hold exactly one section for chain 1, found 0.')
  })
})
