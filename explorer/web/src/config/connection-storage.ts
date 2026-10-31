/**
 * The connection settings that the user typed. They live in the local storage of the browser, under one key.
 * The storage can be absent or can throw (a private window, blocked site data, a preview). So every call is guarded.
 * A failed read gives no settings. A failed write returns a result, so the page can warn.
 *
 * The browser keeps these values in clear text. An RPC URL can hold an API key. The settings page says so.
 *
 * Two cases keep the settings out of the storage. On a shared origin (a path-style IPFS gateway) other sites can read
 * and change the storage, so the settings live in memory for the visit only. On any origin, a URL with a key-like
 * segment is never written, because the storage is clear text.
 */
import { EMPTY_CONNECTION_SETTINGS, ENDPOINT_KEYS, normalizeEndpoint, parseConnectionUrl, type ConnectionSettings } from "@zk-bridge/shared";
import { findSecretLikeValues } from "./secret-scan";
import { originIsShared, type OriginLocation } from "./shared-origin";

/** The part of `Storage` that the connection settings use. */
export type ConnectionStorage = Pick<Storage, "getItem" | "setItem">;

/** The key of the settings. */
export const CONNECTION_STORAGE_KEY = "zk-bridge-explorer.connections";

/**
 * Why a save kept everything, or not.
 * `stored`: the browser kept every setting. `no-storage`: the browser refused. `shared-origin`: the page runs on a
 * path-style gateway, so nothing is written. `key-like-url`: the browser kept the other settings but not a URL that
 * looks like it holds a key.
 */
export type SaveReason = "stored" | "no-storage" | "shared-origin" | "key-like-url";

/** The result of a save. A save that is not `saved` means that a setting lasts only until the page closes. */
export type SaveResult = { readonly saved: boolean; readonly reason: SaveReason };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const validUrl = (value: unknown, purpose: "rpc" | "indexer"): string | null => {
  if (typeof value !== "string") return null;
  const parsed = parseConnectionUrl(value, purpose);
  return parsed.ok ? parsed.url : null;
};

/** A stored endpoint is checked as for an https page, and its warning does not matter: the user saw it at save time. */
const validEndpoint = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const normalized = normalizeEndpoint({ text: value, pageProtocol: "http:" });
  return normalized.ok ? normalized.url : null;
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

/** The msgboard node of each chain, each checked as an endpoint; a bad entry is dropped. */
const boardUrlsOf = (value: unknown): Record<number, string> => {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([name, url]): [number, string][] => {
      const chainId = Number(name);
      const valid = validEndpoint(url);
      return !Number.isInteger(chainId) || chainId <= 0 || valid === null ? [] : [[chainId, valid]];
    }),
  );
};

/** Uses the same scan as the build and the start of the page: one rule for what looks like a key. */
const keyLike = (url: string): boolean => findSecretLikeValues({ url }).length > 0;

const clearIfKeyLike = (url: string | null | undefined): string | null => (url === null || url === undefined || keyLike(url) ? null : url);

const urlsOf = (settings: ConnectionSettings): readonly string[] => [
  ...ENDPOINT_KEYS.flatMap((key) => settings[key] ?? []),
  ...(settings.indexerUrl === null ? [] : [settings.indexerUrl]),
  ...Object.values(settings.rpcUrls),
  ...Object.values(settings.msgboardUrls ?? {}),
  ...Object.values(settings.beaconUrls ?? {}),
];

/** The settings without the URLs that look like they hold a key. */
const withoutKeyLikeUrls = (settings: ConnectionSettings): ConnectionSettings => ({
  ...settings,
  ...Object.fromEntries(ENDPOINT_KEYS.filter((key) => settings[key] !== undefined).map((key) => [key, clearIfKeyLike(settings[key])])),
  indexerUrl: clearIfKeyLike(settings.indexerUrl),
  rpcUrls: Object.fromEntries(Object.entries(settings.rpcUrls).filter(([, url]) => !keyLike(url))),
  ...(settings.msgboardUrls === undefined ? {} : { msgboardUrls: Object.fromEntries(Object.entries(settings.msgboardUrls).filter(([, url]) => !keyLike(url))) }),
  ...(settings.beaconUrls === undefined ? {} : { beaconUrls: Object.fromEntries(Object.entries(settings.beaconUrls).filter(([, url]) => !keyLike(url))) }),
});

/**
 * Reads the settings. A missing storage, a throwing storage, broken JSON and a wrong shape all give no settings.
 * A stored URL that does not pass `parseConnectionUrl` is dropped. A shared origin reads nothing, because another
 * site on the same gateway could have written the value.
 *
 * @param storage The storage, or null when there is none.
 * @param location The location of the page. It defaults to the location of the window.
 */
export const loadUserConnections = (storage: ConnectionStorage | null, location: OriginLocation = window.location): ConnectionSettings => {
  if (storage === null || originIsShared(location)) return EMPTY_CONNECTION_SETTINGS;
  try {
    const parsed: unknown = JSON.parse(storage.getItem(CONNECTION_STORAGE_KEY) ?? "null");
    if (!isRecord(parsed)) return EMPTY_CONNECTION_SETTINGS;
    const endpoints = Object.fromEntries(
      ENDPOINT_KEYS.flatMap((key): [string, string][] => {
        const valid = validEndpoint(parsed[key]);
        return valid === null ? [] : [[key, valid]];
      }),
    );
    const boards = boardUrlsOf(parsed.msgboardUrls);
    // A beacon API is checked as an endpoint, like a msgboard node: one per chain, a bad entry dropped.
    const beacons = boardUrlsOf(parsed.beaconUrls);
    return {
      ...endpoints,
      indexerUrl: validUrl(parsed.indexerUrl, "indexer"),
      rpcUrls: rpcUrlsOf(parsed.rpcUrls),
      ...(Object.keys(boards).length === 0 ? {} : { msgboardUrls: boards }),
      ...(Object.keys(beacons).length === 0 ? {} : { beaconUrls: beacons }),
    };
  } catch {
    return EMPTY_CONNECTION_SETTINGS;
  }
};

/**
 * Writes the settings. Settings with no URL still write, as an empty record, so a forgotten URL stays forgotten.
 * A shared origin writes nothing. A URL that looks like it holds a key is left out of the write on any origin.
 *
 * @param storage The storage, or null when there is none.
 * @param settings The settings to keep.
 * @param location The location of the page. It defaults to the location of the window.
 * @returns Whether the browser kept them, and if not, why.
 */
export const saveUserConnections = (storage: ConnectionStorage | null, settings: ConnectionSettings, location: OriginLocation = window.location): SaveResult => {
  if (originIsShared(location)) return { saved: false, reason: "shared-origin" };
  if (storage === null) return { saved: false, reason: "no-storage" };
  const kept = withoutKeyLikeUrls(settings);
  try {
    storage.setItem(CONNECTION_STORAGE_KEY, JSON.stringify(kept));
  } catch {
    return { saved: false, reason: "no-storage" };
  }
  return urlsOf(kept).length === urlsOf(settings).length ? { saved: true, reason: "stored" } : { saved: false, reason: "key-like-url" };
};
