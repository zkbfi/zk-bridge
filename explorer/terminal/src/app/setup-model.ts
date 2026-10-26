/**
 * The rows of the Prover setup view and the edits that each row accepts. Pure: the view draws the rows, and the
 * edit functions return a new setup. Secrets never pass through here; a row holds a reference and a masked tail.
 */
import {
  ProverSetupError,
  SECRET_NAMES,
  assertEndpointUrl,
  type ChainEndpoints,
  type ProveDirection,
  type ProverSetup,
  type SecretReference,
} from '@zk-bridge/shared/config'
import type { PairConfig } from '../model/types'

/** What a row does when the user presses Enter. */
export type RowKind = 'text' | 'secret' | 'directions' | 'toggle' | 'number' | 'test'

/** One row of the view. */
export interface SetupRow {
  readonly id: string
  readonly label: string
  readonly kind: RowKind
}

/** The rows, in order. The tests come last. */
export function setupRows(pair: PairConfig): readonly SetupRow[] {
  const chains = [pair.first, pair.second]
  return [
    { id: 'endpoint', label: 'RunPod endpoint URL', kind: 'text' },
    { id: 'apiKey', label: 'RunPod API key', kind: 'secret' },
    ...chains.flatMap((chain): SetupRow[] => [
      { id: `rpc:${chain.chainId}`, label: `${chain.name} RPC URL`, kind: 'secret' },
      { id: `beacon:${chain.chainId}`, label: `${chain.name} beacon URL`, kind: 'secret' },
    ]),
    { id: 'msgboard', label: 'msgboard RPC or WebSocket URL', kind: 'secret' },
    { id: 'directions', label: 'Directions to prove', kind: 'directions' },
    { id: 'whenWaits', label: 'Prove when a transfer waits', kind: 'toggle' },
    { id: 'interval', label: 'Prove at least every (seconds)', kind: 'number' },
    { id: 'test:ping', label: 'Test: endpoint /ping', kind: 'test' },
    { id: 'test:dry', label: 'Test: dry proof request', kind: 'test' },
    ...chains.map((chain): SetupRow => ({ id: `test:rpc:${chain.chainId}`, label: `Test: ${chain.name} RPC chain id`, kind: 'test' })),
    { id: 'test:msgboard', label: 'Test: msgboard status()', kind: 'test' },
  ]
}

/** The reference that a secret row holds, or null. */
export function referenceOfRow(setup: ProverSetup, rowId: string): SecretReference | null {
  if (rowId === 'apiKey') return setup.runpodApiKey
  if (rowId === 'msgboard') return setup.msgboardUrl
  const [kind, chainId = ''] = rowId.split(':')
  const endpoints = setup.chains[chainId]
  if (kind === 'rpc') return endpoints?.rpc ?? null
  if (kind === 'beacon') return endpoints?.beacon ?? null
  return null
}

/** The name that the secret store uses for a secret row. */
export function secretNameOfRow(rowId: string): string {
  if (rowId === 'apiKey') return SECRET_NAMES.runpodApiKey
  if (rowId === 'msgboard') return SECRET_NAMES.msgboardUrl
  const [kind, chainId = ''] = rowId.split(':')
  return kind === 'rpc' ? SECRET_NAMES.chainRpc(chainId) : SECRET_NAMES.chainBeacon(chainId)
}

/** Sets the reference of a secret row. Pass null to clear it. */
export function withReference(setup: ProverSetup, rowId: string, reference: SecretReference | null): ProverSetup {
  if (rowId === 'apiKey') return { ...setup, runpodApiKey: reference }
  if (rowId === 'msgboard') return { ...setup, msgboardUrl: reference }
  const [kind, chainId = ''] = rowId.split(':')
  const current: ChainEndpoints = setup.chains[chainId] ?? { rpc: null, beacon: null }
  const next: ChainEndpoints = kind === 'rpc' ? { ...current, rpc: reference } : { ...current, beacon: reference }
  return { ...setup, chains: { ...setup.chains, [chainId]: next } }
}

/**
 * Applies a typed value to a text or number row.
 * @throws ProverSetupError for a value that the row refuses.
 */
export function withTextValue(setup: ProverSetup, rowId: string, text: string): ProverSetup {
  if (rowId === 'endpoint') {
    const trimmed = text.trim()
    if (trimmed !== '') assertEndpointUrl(trimmed)
    return { ...setup, endpointUrl: trimmed }
  }
  if (rowId === 'interval') {
    if (!/^\d+$/.test(text.trim())) throw new ProverSetupError('The interval is a whole number of seconds, zero or more.')
    return { ...setup, policy: { ...setup.policy, intervalSeconds: Number(text.trim()) } }
  }
  return setup
}

const DIRECTION_CYCLE: readonly (readonly ProveDirection[])[] = [
  ['first-to-second', 'second-to-first'],
  ['first-to-second'],
  ['second-to-first'],
]

/** Moves the directions to the next choice: both, first to second, second to first. */
export function withNextDirections(setup: ProverSetup): ProverSetup {
  const index = DIRECTION_CYCLE.findIndex((choice) => choice.length === setup.directions.length && choice.every((direction, position) => setup.directions[position] === direction))
  return { ...setup, directions: DIRECTION_CYCLE[(index + 1) % DIRECTION_CYCLE.length] ?? DIRECTION_CYCLE[0]! }
}

/** Flips the policy that proves when a transfer waits. */
export function withToggledWaitPolicy(setup: ProverSetup): ProverSetup {
  return { ...setup, policy: { ...setup.policy, proveWhenTransferWaits: !setup.policy.proveWhenTransferWaits } }
}

/** The words for the directions row. */
export function directionsText(setup: ProverSetup, pair: PairConfig): string {
  const names = { 'first-to-second': `${pair.first.nativeSymbol}>${pair.second.nativeSymbol}`, 'second-to-first': `${pair.second.nativeSymbol}>${pair.first.nativeSymbol}` }
  return setup.directions.map((direction) => names[direction]).join(' and ') || 'none'
}
