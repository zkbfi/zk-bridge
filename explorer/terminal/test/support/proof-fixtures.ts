/**
 * Proof messages and endpoint settings for the tests of the proof panel and its data source. The values are made up.
 */
import { encodeAbiParameters, type Hex } from 'viem'
import { PROOF_BYTES, encodeProofMessage, proofCategory, type ProofDirection, type ProofMessage, type ResolvedSetting } from '@zk-bridge/shared'
import type { BackendTransport, EndpointSettings } from '../../src/data/backend-source'
import { lightClientOutputParameters } from '../tx/light-client-output'

const word = (digit: string): Hex => `0x${digit.repeat(64)}`

/** A proof message of the pair `eth-pls` whose public values agree with its slots and roots. */
export function proofMessage(overrides: Partial<ProofMessage> = {}): ProofMessage {
  const startRoot = word('a')
  const newRoot = word('b')
  const startSlot = overrides.startSlot ?? 14_099_840n
  const newSlot = overrides.newSlot ?? 14_100_000n
  return {
    version: 1,
    pair: 'eth-pls',
    direction: 'first-to-second',
    programKey: word('9'),
    startSlot,
    startRoot,
    newSlot,
    newRoot,
    publicValues: encodeAbiParameters(lightClientOutputParameters, [word('1'), startRoot, startSlot, word('3'), word('4'), newRoot, newSlot, word('5'), 123n, word('6'), word('7')]),
    proof: `0x${'ab'.repeat(PROOF_BYTES)}`,
    ...overrides,
  }
}

/** The payload of a message, as the board and the msgboard indexer carry it. */
export const payloadOf = (message: ProofMessage): Hex => encodeProofMessage(message)

/** A setting from the user. */
export const userSetting = (value: string): ResolvedSetting => ({ value, source: 'user' })

/** The endpoints with every one unset, then the given ones set. The URLs are made up. */
export function endpoints(set: Partial<Record<keyof EndpointSettings, string>> = {}): EndpointSettings {
  const pick = (key: keyof EndpointSettings): ResolvedSetting | null => (set[key] === undefined ? null : userSetting(set[key]))
  return { backendUrl: pick('backendUrl'), msgboardIndexerUrl: pick('msgboardIndexerUrl'), archiveUrl: pick('archiveUrl'), msgboardUrl: pick('msgboardUrl') }
}

/** The answer of `msgboard_content` for messages of one route. */
export function boardAnswer(direction: ProofDirection, payloads: readonly Hex[]) {
  const category = proofCategory('eth-pls', direction)
  return { status: 200, body: { jsonrpc: '2.0', id: 1, result: { [category]: payloads.map((data, index) => ({ category, data, hash: `0x${index.toString(16).padStart(64, '0')}` })) } } }
}

/** A transport that records its calls and answers with the given functions. */
export function fakeTransport(answers: {
  readonly get?: (url: string) => Promise<{ status: number; body: unknown }>
  readonly post?: (url: string, body: string) => Promise<{ status: number; body: unknown }>
}) {
  const gets: string[] = []
  const posts: string[] = []
  const transport: BackendTransport = {
    fetchJson: async (url) => {
      gets.push(url)
      if (answers.get === undefined) throw new Error('no get expected')
      return answers.get(url)
    },
    postJson: async (url, init) => {
      posts.push(url)
      if (answers.post === undefined) throw new Error('no post expected')
      return answers.post(url, init?.body ?? '')
    },
  }
  return { transport, gets, posts }
}
