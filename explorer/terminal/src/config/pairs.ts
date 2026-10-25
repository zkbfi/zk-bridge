/**
 * Pair configuration: the deployment file that `docker/deploy.sh` writes, plus the environment.
 *
 * This file mirrors the registry in `explorer/shared` (`loadPair`) so that the terminal stands alone. The deployment
 * file shape and the variable names are the same. When the terminal joins the workspace, this file can call the shared
 * registry and map its `Pair` to {@link PairConfig}.
 */
import { getAddress, isAddress, type Address } from 'viem'
import type { ChainConfig, ChainSide, PairConfig } from '../model/types'

/** The default pair. */
export const DEFAULT_PAIR_ID = 'eth-pls'

/** The pairs that the dashboard knows by name. */
const KNOWN_PAIRS: Readonly<Record<string, { label: string; first: ChainDefinition; second: ChainDefinition }>> = {
  'eth-pls': {
    label: 'Ethereum and PulseChain',
    first: { name: 'Ethereum', chainId: 1, nativeSymbol: 'ETH' },
    second: { name: 'PulseChain', chainId: 369, nativeSymbol: 'PLS' },
  },
}

interface ChainDefinition {
  readonly name: string
  readonly chainId: number
  readonly nativeSymbol: string
}

/** The deployment file or the pair name is not valid. */
export class PairConfigError extends Error {
  override readonly name = 'PairConfigError'
}

/** The name of the environment variable that holds the RPC URL of a chain. Same as `explorer/shared`. */
export function rpcVariableName(chainId: number): string {
  return `EXPLORER_RPC_URL_${chainId}`
}

/** The ids of the pairs that the dashboard knows. */
export function knownPairIds(): readonly string[] {
  return Object.keys(KNOWN_PAIRS)
}

/**
 * Builds the pair configuration from a parsed deployment file.
 *
 * @param pairId The pair name, for example `eth-pls`.
 * @param deployment The parsed JSON of the deployment file. Sections are matched to chains by `chain_id`.
 * @throws PairConfigError when the pair is unknown or a chain section is missing or incomplete.
 */
export function buildPairConfig(pairId: string, deployment: unknown): PairConfig {
  const definition = KNOWN_PAIRS[pairId]
  if (definition === undefined) {
    throw new PairConfigError(`Unknown pair "${pairId}". Known pairs: ${knownPairIds().join(', ')}.`)
  }
  return {
    id: pairId,
    label: definition.label,
    first: buildChain('first', definition.first, deployment),
    second: buildChain('second', definition.second, deployment),
  }
}

function buildChain(side: ChainSide, definition: ChainDefinition, deployment: unknown): ChainConfig {
  const section = findSection(deployment, definition.chainId)
  return {
    side,
    chainId: definition.chainId,
    name: definition.name,
    nativeSymbol: definition.nativeSymbol,
    rpcEnvironmentVariable: rpcVariableName(definition.chainId),
    contracts: {
      messageBridge: requiredAddress(section, 'bridge', definition.chainId),
      tokenMediator: requiredAddress(section, 'mediator', definition.chainId),
      lightClient: requiredAddress(section, 'light_client', definition.chainId),
      wrappedNativeRouter: optionalAddress(section, 'native_router'),
      wrappedNative: optionalAddress(section, 'wrapped_native'),
      gate: optionalAddress(section, 'gate'),
      feeRouter: optionalAddress(section, 'fee_router'),
    },
  }
}

function findSection(deployment: unknown, chainId: number): Record<string, unknown> {
  if (typeof deployment !== 'object' || deployment === null) {
    throw new PairConfigError('The deployment file must be a JSON object.')
  }
  const matches = Object.values(deployment).filter(
    (section): section is Record<string, unknown> =>
      typeof section === 'object' && section !== null && (section as { chain_id?: unknown }).chain_id === chainId,
  )
  if (matches.length !== 1) {
    throw new PairConfigError(`The deployment file must hold exactly one section for chain ${chainId}, found ${matches.length}.`)
  }
  return matches[0] as Record<string, unknown>
}

function requiredAddress(section: Record<string, unknown>, key: string, chainId: number): Address {
  const value = optionalAddress(section, key)
  if (value === null) throw new PairConfigError(`The section of chain ${chainId} has no valid address "${key}".`)
  return value
}

function optionalAddress(section: Record<string, unknown>, key: string): Address | null {
  const value = section[key]
  if (typeof value !== 'string' || !isAddress(value, { strict: false })) return null
  return getAddress(value)
}
