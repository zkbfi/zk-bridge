import { describe, expect, test } from 'bun:test'
import { ProverSetupError, SECRET_NAMES, emptyProverSetup, type ProverSetup, type SecretReference } from '@zk-bridge/shared/config'
import { referenceOfRow, secretNameOfRow, withReference, withTextValue } from '../../src/app/setup-model'

const rpcReference: SecretReference = { source: 'environment', variable: 'RPC_ONE' }
const beaconReference: SecretReference = { source: 'store', name: 'beacon-one' }
const keyReference: SecretReference = { source: 'onepassword', reference: 'op://vault/item/field' }

const setup: ProverSetup = {
  ...emptyProverSetup(),
  runpodApiKey: keyReference,
  msgboardUrl: { source: 'environment', variable: 'MSGBOARD' },
  chains: { '1': { rpc: rpcReference, beacon: beaconReference } },
}

describe('referenceOfRow', () => {
  test('reads the reference that each secret row holds', () => {
    expect(referenceOfRow(setup, 'apiKey')).toBe(keyReference)
    expect(referenceOfRow(setup, 'msgboard')).toEqual({ source: 'environment', variable: 'MSGBOARD' })
    expect(referenceOfRow(setup, 'rpc:1')).toBe(rpcReference)
    expect(referenceOfRow(setup, 'beacon:1')).toBe(beaconReference)
  })

  test('is null for a chain with no endpoints and for a row that is not a secret row', () => {
    expect(referenceOfRow(setup, 'rpc:369')).toBeNull()
    expect(referenceOfRow(setup, 'beacon:369')).toBeNull()
    expect(referenceOfRow(setup, 'interval')).toBeNull()
    expect(referenceOfRow(setup, 'test:rpc:1')).toBeNull()
  })
})

describe('secretNameOfRow', () => {
  test('gives each row its own name in the secret store', () => {
    expect(secretNameOfRow('apiKey')).toBe(SECRET_NAMES.runpodApiKey)
    expect(secretNameOfRow('msgboard')).toBe(SECRET_NAMES.msgboardUrl)
    expect(secretNameOfRow('rpc:369')).toBe('explorer.prover.chain.369.rpc')
    expect(secretNameOfRow('beacon:369')).toBe('explorer.prover.chain.369.beacon')
  })
})

describe('withReference', () => {
  test('sets the api key and the msgboard url and leaves the rest', () => {
    const next = withReference(setup, 'apiKey', rpcReference)
    expect(next.runpodApiKey).toBe(rpcReference)
    expect(next.chains).toBe(setup.chains)
    expect(withReference(setup, 'msgboard', null).msgboardUrl).toBeNull()
  })

  test('a new chain gets both endpoints, one set and one empty', () => {
    const next = withReference(setup, 'rpc:369', rpcReference)
    expect(next.chains['369']).toEqual({ rpc: rpcReference, beacon: null })
    expect(next.chains['1']).toBe(setup.chains['1']!)
  })

  test('setting the beacon keeps the rpc of the same chain, and clearing sets null', () => {
    const next = withReference(setup, 'beacon:1', keyReference)
    expect(next.chains['1']).toEqual({ rpc: rpcReference, beacon: keyReference })
    expect(withReference(setup, 'rpc:1', null).chains['1']).toEqual({ rpc: null, beacon: beaconReference })
  })

  test('does not change the setup that it was given', () => {
    withReference(setup, 'rpc:1', null)
    expect(setup.chains['1']?.rpc).toBe(rpcReference)
  })
})

describe('withTextValue', () => {
  test('a row that takes no text returns the same setup', () => {
    expect(withTextValue(setup, 'directions', 'anything')).toBe(setup)
  })

  test('the interval is a whole number of seconds, trimmed', () => {
    expect(withTextValue(setup, 'interval', ' 90 ').policy.intervalSeconds).toBe(90)
    expect(withTextValue(setup, 'interval', '0').policy.intervalSeconds).toBe(0)
    expect(() => withTextValue(setup, 'interval', '1.5')).toThrow(new ProverSetupError('The interval is a whole number of seconds, zero or more.'))
    expect(() => withTextValue(setup, 'interval', '-1')).toThrow(ProverSetupError)
  })

  test('a blank endpoint clears it without a check', () => {
    expect(withTextValue({ ...setup, endpointUrl: 'https://old.example' }, 'endpoint', '  ').endpointUrl).toBe('')
  })
})
