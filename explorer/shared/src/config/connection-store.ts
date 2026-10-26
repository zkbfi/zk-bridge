/**
 * Where the terminal keeps the connection settings that the user typed: in the secret store, one secret per setting,
 * because an RPC URL or an indexer URL can hold an API key. The settings file of the dashboard never holds one.
 */
import { parseConnectionUrl, type ConnectionSettings } from '../connection-settings.js'
import type { SecretStore } from './secret-store.js'

/** The names under which the secret store keeps the settings. */
export const CONNECTION_SECRET_NAMES = {
  indexerUrl: 'explorer.connection.indexer',
  rpcUrl: (chainId: number): string => `explorer.connection.rpc.${chainId}`,
} as const

/** Which setting to change. */
export type ConnectionSettingKey = { readonly kind: 'indexer' } | { readonly kind: 'rpc'; readonly chainId: number }

const nameOf = (key: ConnectionSettingKey): string => (key.kind === 'indexer' ? CONNECTION_SECRET_NAMES.indexerUrl : CONNECTION_SECRET_NAMES.rpcUrl(key.chainId))

/**
 * Reads the settings of the user. A stored text that is not a valid URL is ignored, so a damaged entry cannot stop the
 * dashboard from starting.
 *
 * @param store The secret store.
 * @param chainIds The chains of the pair.
 */
export async function loadConnectionSettings(store: SecretStore, chainIds: readonly number[]): Promise<ConnectionSettings> {
  const read = async (key: ConnectionSettingKey, purpose: 'rpc' | 'indexer'): Promise<string | null> => {
    const text = await store.get(nameOf(key))
    if (text === null) return null
    const parsed = parseConnectionUrl(text, purpose)
    return parsed.ok ? parsed.url : null
  }
  const rpcEntries = await Promise.all(chainIds.map(async (chainId) => [chainId, await read({ kind: 'rpc', chainId }, 'rpc')] as const))
  return {
    indexerUrl: await read({ kind: 'indexer' }, 'indexer'),
    rpcUrls: Object.fromEntries(rpcEntries.filter((entry): entry is readonly [number, string] => entry[1] !== null)),
  }
}

/**
 * Stores one setting, or forgets it.
 *
 * @param store The secret store.
 * @param key Which setting.
 * @param url The URL, already checked with `parseConnectionUrl`. Null forgets the setting.
 */
export async function saveConnectionSetting(store: SecretStore, key: ConnectionSettingKey, url: string | null): Promise<void> {
  if (url === null) return store.delete(nameOf(key))
  return store.set(nameOf(key), url)
}
