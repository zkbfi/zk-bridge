/**
 * The connection settings that the user typed. They live in the local storage of the browser, under one key.
 * The storage can be absent or can throw (a private window, blocked site data, a preview). So every call is guarded.
 * A failed read gives no settings. A failed write returns a result, so the page can warn.
 *
 * The browser keeps these values in clear text. An RPC URL can hold an API key. The settings page says so.
 */
import { EMPTY_CONNECTION_SETTINGS, parseConnectionUrl, type ConnectionSettings } from "@zk-bridge/shared";

/** The part of `Storage` that the connection settings use. */
export type ConnectionStorage = Pick<Storage, "getItem" | "setItem">;

/** The key of the settings. */
export const CONNECTION_STORAGE_KEY = "zk-bridge-explorer.connections";

/** The result of a save. A failed save means that the setting lasts only until the page closes. */
export type SaveResult = { readonly saved: boolean };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const validUrl = (value: unknown, purpose: "rpc" | "indexer"): string | null => {
  if (typeof value !== "string") return null;
  const parsed = parseConnectionUrl(value, purpose);
  return parsed.ok ? parsed.url : null;
};

const rpcUrlsOf = (value: unknown): Record<number, string> => {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([name, url]): [number, string][] => {
      const chainId = Number(name);
      const valid = validUrl(url, "rpc");
      if (!Number.isInteger(chainId) || chainId <= 0 || valid === null) return [];
      return [[chainId, valid]];
    }),
  );
};

/**
 * Reads the settings. A missing storage, a throwing storage, broken JSON and a wrong shape all give no settings.
 * A stored URL that does not pass `parseConnectionUrl` is dropped.
 *
 * @param storage The storage, or null when there is none.
 */
export const loadUserConnections = (storage: ConnectionStorage | null): ConnectionSettings => {
  if (storage === null) return EMPTY_CONNECTION_SETTINGS;
  try {
    const parsed: unknown = JSON.parse(storage.getItem(CONNECTION_STORAGE_KEY) ?? "null");
    if (!isRecord(parsed)) return EMPTY_CONNECTION_SETTINGS;
    return { indexerUrl: validUrl(parsed.indexerUrl, "indexer"), rpcUrls: rpcUrlsOf(parsed.rpcUrls) };
  } catch {
    return EMPTY_CONNECTION_SETTINGS;
  }
};

/**
 * Writes the settings. Settings with no URL still write, as an empty record, so a forgotten URL stays forgotten.
 *
 * @param storage The storage, or null when there is none.
 * @param settings The settings to keep.
 * @returns Whether the browser kept them.
 */
export const saveUserConnections = (storage: ConnectionStorage | null, settings: ConnectionSettings): SaveResult => {
  if (storage === null) return { saved: false };
  try {
    storage.setItem(CONNECTION_STORAGE_KEY, JSON.stringify(settings));
    return { saved: true };
  } catch {
    return { saved: false };
  }
};
