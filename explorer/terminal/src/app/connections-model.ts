/**
 * The rows of the Connections view and the actions that each row takes. Pure apart from the calls to the runtime and
 * the secret store, which the caller passes in. No text that this file returns holds a URL: every message goes through
 * the redaction of the runtime, and a URL that the user typed is redacted too.
 */
import { parseConnectionUrl, redactConnectionText, type ConnectionSettings, type HttpClient, type TestOutcome } from '@zk-bridge/shared'
import { redactError, saveConnectionSetting, type ConnectionSettingKey, type SecretStore } from '@zk-bridge/shared/config'
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

/** The rows, in order: the URLs, then the tests, then the check. */
export function connectionRows(pair: PairConfig): readonly ConnectionRow[] {
  const chains = [pair.first, pair.second]
  return [
    { id: 'indexer', label: 'Indexer URL', kind: 'url' },
    ...chains.map((chain): ConnectionRow => ({ id: `rpc:${chain.chainId}`, label: `${chain.name} RPC URL`, kind: 'url' })),
    { id: 'test:indexer', label: 'Test: indexer', kind: 'test' },
    ...chains.map((chain): ConnectionRow => ({ id: `test:rpc:${chain.chainId}`, label: `Test: ${chain.name} RPC chain id`, kind: 'test' })),
    { id: 'check', label: 'Check the indexer now', kind: 'check' },
  ]
}

/** The setting that a URL row holds, as the secret store names it. Call it for a row of kind `url` only. */
export function settingKeyOfRow(row: ConnectionRow): ConnectionSettingKey {
  if (row.id === 'indexer') return { kind: 'indexer' }
  return { kind: 'rpc', chainId: Number(row.id.split(':')[1]) }
}

/** The settings of the user with one setting replaced. A null URL removes it. */
export function withSetting(settings: ConnectionSettings, key: ConnectionSettingKey, url: string | null): ConnectionSettings {
  if (key.kind === 'indexer') return { ...settings, indexerUrl: url }
  const others = Object.fromEntries(Object.entries(settings.rpcUrls).filter(([chainId]) => Number(chainId) !== key.chainId))
  return { ...settings, rpcUrls: url === null ? others : { ...others, [key.chainId]: url } }
}

/** True when two settings name the same URLs for the given chains. */
export function sameSettings(first: ConnectionSettings, second: ConnectionSettings, chainIds: readonly number[]): boolean {
  return first.indexerUrl === second.indexerUrl && chainIds.every((chainId) => first.rpcUrls[chainId] === second.rpcUrls[chainId])
}

/** True when the user has set at least one URL. */
export function hasUserSettings(settings: ConnectionSettings): boolean {
  return settings.indexerUrl !== null || Object.keys(settings.rpcUrls).length > 0
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
  readonly key: ConnectionSettingKey
  readonly text: string
  readonly http: HttpClient
}): Promise<ActionResult> {
  const { runtime, store, key, http } = input
  const parsed = parseConnectionUrl(input.text, key.kind)
  if (!parsed.ok) return { ok: false, message: parsed.message }
  const url = parsed.url
  try {
    if (key.kind === 'rpc') {
      const outcome = await runtime.testRpcUrl(key.chainId, url, http)
      if (outcome.ok === 'fail') return { ok: false, message: `Not saved. ${runtime.redact(redactConnectionText(outcome.message, [url]))}` }
    }
    await saveConnectionSetting(store, key, url)
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
export async function forgetUrlSetting(input: { readonly runtime: ConnectionRuntime; readonly store: SecretStore; readonly key: ConnectionSettingKey }): Promise<ActionResult> {
  const { runtime, store, key } = input
  const held = key.kind === 'indexer' ? runtime.user().indexerUrl : runtime.user().rpcUrls[key.chainId]
  if (held === undefined || held === null) return { ok: false, message: 'You set no value here, so nothing is forgotten.' }
  try {
    await saveConnectionSetting(store, key, null)
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

