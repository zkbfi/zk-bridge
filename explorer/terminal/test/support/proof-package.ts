import { encodeAbiParameters, type Hex } from 'viem'
import { FIXTURE_PAIR } from '../../src/data/fixtures'
import { encodeUpdateCalldata } from '../../src/tx/operator'
import { lightClientOutputParameters } from '../tx/light-client-output'

const word = (digit: string): Hex => `0x${digit.repeat(64)}`

/** The JSON that `zk-bridge-prover prove` prints for an update from slot 100 to slot 200, aimed at the fixture pair. */
export function proofPackageText(): string {
  const values = encodeAbiParameters(lightClientOutputParameters, [word('a'), word('b'), 100n, word('c'), word('d'), word('e'), 200n, word('f'), 21n, word('9'), word('8')])
  const proof: Hex = `0x${'12'.repeat(260)}`
  return JSON.stringify({
    schemaVersion: 1,
    route: 'ethereum_to_pulsechain',
    programKey: word('9'),
    startHeadSlot: 100,
    startHeadRoot: word('b'),
    newHeadSlot: 200,
    newHeadRoot: word('e'),
    latestFinalizedSlot: 200,
    publicValues: values,
    proof,
    updateCalldata: encodeUpdateCalldata(proof, values),
    backend: 'sp1',
    destination: { chainId: 369, lightClient: FIXTURE_PAIR.second.contracts.lightClient },
    createdAt: '2026-10-28T09:30:00Z',
  })
}
