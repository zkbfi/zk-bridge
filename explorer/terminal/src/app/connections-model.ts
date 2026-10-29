/**
 * The rows of the Connections view and the actions that each row takes. Pure apart from the calls to the runtime and
 * the secret store, which the caller passes in. No text that this file returns holds a URL: every message goes through
 * the redaction of the runtime, and a URL that the user typed is redacted too.
 */
import {
  ENDPOINT_KEYS,
  normalizeEndpoint,
  parseConnectionUrl,
  redactConnectionText,
  type ConnectionSettings,
  type EndpointKey,
  type HttpClient,
  type TestOutcome,
} from '@zk-bridge/shared'
import { loadConnectionSettings, redactError, saveConnectionSetting, type ConnectionSettingKey, type SecretStore } from '@zk-bridge/shared/config'
import type { PairConfig } from '../model/types'
import type { ConnectionRuntime } from '../data/connection-runtime'

/** What a row does when the user presses Enter. `url` edits a setting. `test` runs a test. `check` asks the indexer now. */
export type ConnectionRowKind = 'url' | 'test' | 'check'

/** One row of the view. */
export interface ConnectionRow {
  readonly id: string
  readonly label: string
  readonly kind: ConnectionRowKind
}

/** The result of an action that changes a setting. The message holds no URL. */
export type ActionResult = { readonly ok: true } | { readonly ok: false; readonly message: string }

/** The words for each endpoint beside the indexer. The web page uses the same words. */
export const ENDPOINT_LABELS: Readonly<Record<EndpointKey, string>> = {
  backendUrl: 'Backend URL',
  msgboardIndexerUrl: 'Msgboard indexer URL',
  archiveUrl: 'Archive URL',
  msgboardUrl: 'Msgboard node URL',
}

/** The names under which the store keeps the endpoints. An endpoint can hold a key in its path. */
export const ENDPOINT_STORE_NAMES: Readonly<Record<EndpointKey, string>> = {
  backendUrl: 'explorer.connection.endpoint.backendUrl',
  msgboardIndexerUrl: 'explorer.connection.endpoint.msgboardIndexerUrl',
  archiveUrl: 'explorer.connection.endpoint.archiveUrl',
  msgboardUrl: 'explorer.connection.endpoint.msgboardUrl',
}

/** The setting that a URL row holds: the indexer, the RPC URL of a chain, or one of the other endpoints. */
export type ConnectionRowKey = ConnectionSettingKey | { readonly kind: 'endpoint'; readonly key: EndpointKey }

const endpointRowId = (key: EndpointKey): string => `endpoint:${key}`

/** The rows, in order: the URLs, then the tests, then the check. */
export function connectionRows(pair: PairConfig): readonly ConnectionRow[] {
  const chains = [pair.first, pair.second]
  return [
    { id: 'indexer', label: 'Indexer URL', kind: 'url' },
    ...chains.map((chain): ConnectionRow => ({ id: `rpc:${chain.chainId}`, label: `${chain.name} RPC URL`, kind: 'url' })),
    ...ENDPOINT_KEYS.map((key): ConnectionRow => ({ id: endpointRowId(key), label: ENDPOINT_LABELS[key], kind: 'url' })),
    { id: 'test:indexer', label: 'Test: indexer', kind: 'test' },
    ...chains.map((chain): ConnectionRow => ({ id: `test:rpc:${chain.chainId}`, label: `Test: ${chain.name} RPC chain id`, kind: 'test' })),
    { id: 'check', label: 'Check the indexer now', kind: 'check' },
  ]
}

/** The setting that a URL row holds, as the secret store names it. Call it for a row of kind `url` only. */
export function settingKeyOfRow(row: ConnectionRow): ConnectionRowKey {
  if (row.id === 'indexer') return { kind: 'indexer' }
  const endpoint = ENDPOINT_KEYS.find((key) => endpointRowId(key) === row.id)
  if (endpoint !== undefined) return { kind: 'endpoint', key: endpoint }
  return { kind: 'rpc', chainId: Number(row.id.split(':')[1]) }
}

/** The URL that the user set for a row, or null. */
export function userUrlOfKey(settings: ConnectionSettings, key: ConnectionRowKey): string | null {
  if (key.kind === 'endpoint') return settings[key.key] ?? null
  if (key.kind === 'indexer') return settings.indexerUrl
  return settings.rpcUrls[key.chainId] ?? null
}

/** The settings of the user with one setting replaced. A null URL removes it. */
export function withSetting(settings: ConnectionSettings, key: ConnectionRowKey, url: string | null): ConnectionSettings {
  if (key.kind === 'endpoint') return { ...settings, [key.key]: url }
  if (key.kind === 'indexer') return { ...settings, indexerUrl: url }
  const others = Object.fromEntries(Object.entries(settings.rpcUrls).filter(([chainId]) => Number(chainId) !== key.chainId))
  return { ...settings, rpcUrls: url === null ? others : { ...others, [key.chainId]: url } }
}

/** True when two settings name the same URLs for the given chains. */
export function sameSettings(first: ConnectionSettings, second: ConnectionSettings, chainIds: readonly number[]): boolean {
  const sameEndpoints = ENDPOINT_KEYS.every((key) => (first[key] ?? null) === (second[key] ?? null))
  return sameEndpoints && first.indexerUrl === second.indexerUrl && chainIds.every((chainId) => first.rpcUrls[chainId] === second.rpcUrls[chainId])
}

/** True when the user has set at least one URL. */
export function hasUserSettings(settings: ConnectionSettings): boolean {
  return settings.indexerUrl !== null || Object.keys(settings.rpcUrls).length > 0 || ENDPOINT_KEYS.some((key) => (settings[key] ?? null) !== null)
}

/** Stores the setting of a row, or forgets it when the URL is null. The URL is already checked. */
export async function storeRowSetting(store: SecretStore, key: ConnectionRowKey, url: string | null): Promise<void> {
  if (key.kind !== 'endpoint') return saveConnectionSetting(store, key, url)
  const name = ENDPOINT_STORE_NAMES[key.key]
  return url === null ? store.delete(name) : store.set(name, url)
}

/**
 * Reads the four endpoints that the user saved. A stored text that is not a valid endpoint is ignored, so a damaged
 * entry cannot stop the dashboard from starting.
 *
 * @param store The open store.
 */
export async function loadEndpointSettings(store: SecretStore): Promise<Partial<Record<EndpointKey, string | null>>> {
  const entries = await Promise.all(
    ENDPOINT_KEYS.map(async (key) => {
      const text = await store.get(ENDPOINT_STORE_NAMES[key])
      const checked = text === null ? null : normalizeEndpoint({ text, pageProtocol: 'http:' })
      return [key, checked !== null && checked.ok ? checked.url : null] as const
    }),
  )
  return Object.fromEntries(entries)
}

/**
 * Reads every setting that the user saved: the indexer, the RPC URL of each chain and the four endpoints.
 *
 * @param store The open store.
 * @param chainIds The chains of the pair.
 */
export async function loadUserSettings(store: SecretStore, chainIds: readonly number[]): Promise<ConnectionSettings> {
  return { ...(await loadConnectionSettings(store, chainIds)), ...(await loadEndpointSettings(store)) }
}

/** Checks the text for the kind of URL that the row holds. */
function checkedUrl(key: ConnectionRowKey, text: string): ReturnType<typeof parseConnectionUrl> {
  if (key.kind !== 'endpoint') return parseConnectionUrl(text, key.kind)
  const endpoint = normalizeEndpoint({ text, pageProtocol: 'http:' })
  return endpoint.ok ? { ok: true, url: endpoint.url } : { ok: false, message: endpoint.reason }
}

/** An error as a sentence with no secret and no URL. */
export function safeMessage(runtime: ConnectionRuntime, error: unknown, urls: readonly string[]): string {
  return runtime.redact(redactConnectionText(redactError(error, urls), urls))
}

/**
 * Checks, tests and saves one URL that the user typed. An RPC URL must first answer with the chain identifier of its
 * chain. A URL that fails any step is not saved, and the runtime does not change.
 *
 * @param input The runtime, the open secret store, the row, the typed text and the HTTP client of the tests.
 */
export async function saveUrlSetting(input: {
  readonly runtime: ConnectionRuntime
  readonly store: SecretStore
  readonly key: ConnectionRowKey
  readonly text: string
  readonly http: HttpClient
}): Promise<ActionResult> {
  const { runtime, store, key, http } = input
  const parsed = checkedUrl(key, input.text)
  if (!parsed.ok) return { ok: false, message: parsed.message }
  const url = parsed.url
  try {
    if (key.kind === 'rpc') {
      const outcome = await runtime.testRpcUrl(key.chainId, url, http)
      if (outcome.ok === 'fail') return { ok: false, message: `Not saved. ${runtime.redact(redactConnectionText(outcome.message, [url]))}` }
    }
    await storeRowSetting(store, key, url)
    runtime.apply(withSetting(runtime.user(), key, url))
    return { ok: true }
  } catch (error) {
    return { ok: false, message: `Not saved. ${safeMessage(runtime, error, [url])}` }
  }
}

/**
 * Forgets the setting of the user for one URL row. The row returns to the weaker source: the environment or the default.
 *
 * @param input The runtime, the open secret store and the key.
 */
export async function forgetUrlSetting(input: { readonly runtime: ConnectionRuntime; readonly store: SecretStore; readonly key: ConnectionRowKey }): Promise<ActionResult> {
  const { runtime, store, key } = input
  const held = userUrlOfKey(runtime.user(), key)
  if (held === null) return { ok: false, message: 'You set no value here, so nothing is forgotten.' }
  try {
    await storeRowSetting(store, key, null)
    runtime.apply(withSetting(runtime.user(), key, null))
    return { ok: true }
  } catch (error) {
    return { ok: false, message: `Not forgotten. ${safeMessage(runtime, error, [held])}` }
  }
}

/**
 * Tests the URL that is in force now for a test row.
 *
 * @param input The runtime, the row and the HTTP client.
 */
export async function runUrlTest(input: { readonly runtime: ConnectionRuntime; readonly row: ConnectionRow; readonly http: HttpClient }): Promise<TestOutcome> {
  const { runtime, row, http } = input
  const resolved = runtime.resolved()
  const chainId = Number(row.id.split(':')[2])
  const setting = row.id === 'test:indexer' ? resolved.indexerUrl : resolved.rpcUrls[chainId]
  if (setting === null || setting === undefined) return { ok: 'fail', message: row.id === 'test:indexer' ? 'No indexer URL is set.' : `No RPC URL is set for chain ${chainId}.` }
  try {
    return row.id === 'test:indexer' ? await runtime.testIndexer(setting.value, http) : await runtime.testRpcUrl(chainId, setting.value, http)
  } catch (error) {
    return { ok: 'fail', message: safeMessage(runtime, error, [setting.value]) }
  }
}

/**
 * Asks the indexer now, and tells which source answers afterwards.
 *
 * @param runtime The runtime.
 */
export async function checkIndexerNow(runtime: ConnectionRuntime): Promise<string> {
  try {
    await runtime.connection().checkNow()
    return `Checked. Using: ${runtime.source().label}`
  } catch (error) {
    return `The check failed: ${safeMessage(runtime, error, [])}`
  }
}

