/**
 * The configuration of the proof side: the schema, its validation and its defaults.
 *
 * The file that holds this configuration never holds a secret. Each secret is a reference: a name in the secret store,
 * an environment variable, or a 1Password reference. The proof publisher bot (`docs/bots.md`) reads the same file and
 * resolves the same references with `resolveSecretReference`. No import here touches the terminal library.
 */

/** Where a secret value lives. The configuration holds this, not the value. */
export type SecretReference =
  | { readonly source: 'store'; readonly name: string }
  | { readonly source: 'environment'; readonly variable: string }
  | { readonly source: 'onepassword'; readonly reference: string }

/** A direction of a pair that the operator proves. */
export type ProveDirection = 'first-to-second' | 'second-to-first'

/** The endpoints of one chain. Keyed URLs are secrets, so both are references. */
export interface ChainEndpoints {
  readonly rpc: SecretReference | null
  readonly beacon: SecretReference | null
  /** More beacon APIs for states only, as one comma separated value. Absent when the file names none. */
  readonly stateUrls?: SecretReference | null
}

/** The proving policy. */
export interface ProvingPolicy {
  /** Prove when a transfer or message waits for a head that does not cover it. */
  readonly proveWhenTransferWaits: boolean
  /** Prove at least this often, in seconds. Zero means only when a transfer waits. */
  readonly intervalSeconds: number
}

/** The whole configuration. */
export interface ProverSetup {
  readonly schemaVersion: 1
  /** The RunPod load balancing endpoint, such as `https://<id>.api.runpod.ai`. It holds no key, so it is plain text. */
  readonly endpointUrl: string
  readonly runpodApiKey: SecretReference | null
  /** Endpoints by chain identifier. */
  readonly chains: Readonly<Record<string, ChainEndpoints>>
  /** The msgboard RPC or WebSocket URL. */
  readonly msgboardUrl: SecretReference | null
  readonly pair: string
  readonly directions: readonly ProveDirection[]
  readonly policy: ProvingPolicy
}

/** The setup that a new installation starts with. */
export function emptyProverSetup(pair = 'eth-pls'): ProverSetup {
  return {
    schemaVersion: 1,
    endpointUrl: '',
    runpodApiKey: null,
    chains: {},
    msgboardUrl: null,
    pair,
    directions: ['first-to-second', 'second-to-first'],
    policy: { proveWhenTransferWaits: true, intervalSeconds: 3600 },
  }
}

/** The configuration is not valid. The message names the field. */
export class ProverSetupError extends Error {
  override readonly name = 'ProverSetupError'
}

/**
 * Checks a parsed JSON value and returns it as a {@link ProverSetup}. It refuses a file that holds a secret value
 * where a reference belongs, so a hand-edited file cannot smuggle a key into a place that later gets logged.
 *
 * @throws ProverSetupError with the path of the first invalid field.
 */
export function parseProverSetup(value: unknown): ProverSetup {
  const root = asRecord(value, 'setup')
  if (root.schemaVersion !== 1) throw new ProverSetupError('setup.schemaVersion must be 1.')
  const endpointUrl = asString(root.endpointUrl, 'setup.endpointUrl')
  if (endpointUrl !== '') assertEndpointUrl(endpointUrl)
  const chains: Record<string, ChainEndpoints> = {}
  for (const [chainId, entry] of Object.entries(asRecord(root.chains ?? {}, 'setup.chains'))) {
    if (!/^\d+$/.test(chainId)) throw new ProverSetupError(`setup.chains key "${chainId}" is not a chain identifier.`)
    const record = asRecord(entry, `setup.chains.${chainId}`)
    const stateUrls = parseReference(record.stateUrls, `setup.chains.${chainId}.stateUrls`)
    chains[chainId] = {
      rpc: parseReference(record.rpc, `setup.chains.${chainId}.rpc`),
      beacon: parseReference(record.beacon, `setup.chains.${chainId}.beacon`),
      ...(stateUrls === null ? {} : { stateUrls }),
    }
  }
  const policy = asRecord(root.policy, 'setup.policy')
  const intervalSeconds = policy.intervalSeconds
  if (typeof intervalSeconds !== 'number' || !Number.isInteger(intervalSeconds) || intervalSeconds < 0) {
    throw new ProverSetupError('setup.policy.intervalSeconds must be a whole number of seconds, zero or more.')
  }
  const directions = asArray(root.directions, 'setup.directions').map((entry) => {
    if (entry === 'first-to-second' || entry === 'second-to-first') return entry
    throw new ProverSetupError('setup.directions holds only first-to-second and second-to-first.')
  })
  return {
    schemaVersion: 1,
    endpointUrl,
    runpodApiKey: parseReference(root.runpodApiKey, 'setup.runpodApiKey'),
    chains,
    msgboardUrl: parseReference(root.msgboardUrl, 'setup.msgboardUrl'),
    pair: asString(root.pair, 'setup.pair'),
    directions,
    policy: { proveWhenTransferWaits: policy.proveWhenTransferWaits === true, intervalSeconds },
  }
}

/** Checks the endpoint URL: https, or http on the local machine, and no credentials inside. */
export function assertEndpointUrl(text: string): void {
  let url: URL
  try {
    url = new URL(text)
  } catch {
    throw new ProverSetupError('The endpoint URL is not a URL.')
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new ProverSetupError('The endpoint URL must use https, or http on the local machine.')
  }
  if (url.username !== '' || url.password !== '' || url.search !== '') {
    throw new ProverSetupError('The endpoint URL must not hold credentials or a query. Put the key in the API key field.')
  }
}

/** The name that the secret store uses for a part of the setup. */
export const SECRET_NAMES = {
  runpodApiKey: 'explorer.prover.runpod-api-key',
  msgboardUrl: 'explorer.prover.msgboard-url',
  chainRpc: (chainId: string | number) => `explorer.prover.chain.${chainId}.rpc`,
  chainBeacon: (chainId: string | number) => `explorer.prover.chain.${chainId}.beacon`,
} as const

/** Reads a reference from its text form: `env:NAME`, `op://vault/item/field`, or `store:NAME`. */
export function parseReferenceText(text: string): SecretReference {
  const trimmed = text.trim()
  if (trimmed.startsWith('op://')) {
    if (!/^op:\/\/[^/\s]+\/[^/\s]+\/[^\s]+$/.test(trimmed)) throw new ProverSetupError('A 1Password reference looks like op://vault/item/field.')
    return { source: 'onepassword', reference: trimmed }
  }
  if (trimmed.startsWith('env:')) {
    const variable = trimmed.slice(4)
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable)) throw new ProverSetupError('An environment variable name uses letters, digits and underscores.')
    return { source: 'environment', variable }
  }
  throw new ProverSetupError('A reference is env:NAME or op://vault/item/field. To type a secret, use the secret field.')
}

/** The text form of a reference, for the screen. */
export function referenceText(reference: SecretReference): string {
  if (reference.source === 'store') return `stored (${reference.name})`
  if (reference.source === 'environment') return `env:${reference.variable}`
  return reference.reference
}

function parseReference(value: unknown, where: string): SecretReference | null {
  if (value === null || value === undefined) return null
  const record = asRecord(value, where)
  if (record.source === 'store' && typeof record.name === 'string') return { source: 'store', name: record.name }
  if (record.source === 'environment' && typeof record.variable === 'string') return { source: 'environment', variable: record.variable }
  if (record.source === 'onepassword' && typeof record.reference === 'string') return { source: 'onepassword', reference: record.reference }
  throw new ProverSetupError(`${where} must be a reference to a secret store, an environment variable or a 1Password item, never a value.`)
}

function asRecord(value: unknown, where: string): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Record<string, unknown>
  throw new ProverSetupError(`${where} must be an object.`)
}

function asArray(value: unknown, where: string): unknown[] {
  if (Array.isArray(value)) return value
  throw new ProverSetupError(`${where} must be a list.`)
}

function asString(value: unknown, where: string): string {
  if (typeof value === 'string') return value
  throw new ProverSetupError(`${where} must be text.`)
}
