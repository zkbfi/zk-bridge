import { isRegistrableSecret, maskSecret, redactSecrets } from "./redaction.js";

/**
 * The connections of the dashboards: the indexer URL and one RPC URL per chain. This module holds the pure rules that
 * the terminal and the web page share: where a setting comes from, what a valid URL is, how a URL shows on a screen,
 * and how it is kept out of logs. An RPC URL can embed an API key, so every function here treats a URL as a secret.
 */

/** The settings that the user typed. A chain or the indexer with no entry has no user setting. */
export type ConnectionSettings = {
  readonly indexerUrl: string | null;
  readonly rpcUrls: Readonly<Record<number, string>>;
  /**
   * The msgboard node of each chain (owner, quote 87: "the board node is actually supposed to be assigned per chain. it
   * can be the same url, but the ui should grab the info twice in that case"). A chain with no entry falls back to the
   * single `msgboardUrl` of the same source, which older settings and the terminal still use.
   */
  readonly msgboardUrls?: Readonly<Record<number, string>>;
} & Partial<Readonly<Record<EndpointKey, string | null>>>;

/**
 * The endpoints beside the indexer and the RPC URLs: the backend, the msgboard indexer, the archive and the msgboard
 * node. Each one is configured, never discovered. A client ships a default and the user can change it.
 */
export const ENDPOINT_KEYS = ["backendUrl", "msgboardIndexerUrl", "archiveUrl", "msgboardUrl"] as const;

/** The name of one of the endpoints in {@link ENDPOINT_KEYS}. */
export type EndpointKey = (typeof ENDPOINT_KEYS)[number];

/** The address of the indexer when nothing sets another. */
export const DEFAULT_INDEXER_URL = "http://localhost:42069";

/** No user setting at all. */
export const EMPTY_CONNECTION_SETTINGS: ConnectionSettings = { indexerUrl: null, rpcUrls: {} };

/** Where a resolved setting comes from, from the strongest to the weakest. */
export type SettingSource = "user" | "environment" | "default";

/** The order of precedence: the user setting, then the environment, then the registry default. */
export const SETTING_SOURCES: readonly SettingSource[] = ["user", "environment", "default"];

/** A setting after resolution. */
export type ResolvedSetting = { readonly value: string; readonly source: SettingSource };

/** The settings that one source offers. An absent, empty or blank value means that the source has no setting. */
export type ConnectionLayer = {
  readonly indexerUrl?: string | null | undefined;
  readonly rpcUrls?: Readonly<Record<number, string | null | undefined>> | undefined;
  readonly msgboardUrls?: Readonly<Record<number, string | null | undefined>> | undefined;
} & Partial<Readonly<Record<EndpointKey, string | null | undefined>>>;

/** The settings in force. */
export type ResolvedConnection = {
  readonly indexerUrl: ResolvedSetting | null;
  readonly rpcUrls: Readonly<Record<number, ResolvedSetting | null>>;
  /**
   * The msgboard node of each chain: in each source, the chain's own entry, else that source's single `msgboardUrl`.
   * Absent on a connection built before boards were per chain; read it with {@link boardUrlOf}.
   */
  readonly msgboardUrls?: Readonly<Record<number, ResolvedSetting | null>>;
} & Readonly<Record<EndpointKey, ResolvedSetting | null>>;

/** The inputs of {@link resolveConnection}. */
export type ResolveConnectionInput = {
  readonly chainIds: readonly number[];
  /** What the user set in the settings view. */
  readonly user: ConnectionLayer;
  /** What the environment or the deployment of the page set (`EXPLORER_*` variables, `VITE_EXPLORER_*` variables). */
  readonly environment: ConnectionLayer;
  /** What the pair registry offers (`rpc_url` of the deployment file, and the standard indexer address). */
  readonly registry: ConnectionLayer;
};

const present = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? null : trimmed;
};

const firstSetting = (candidates: readonly (readonly [SettingSource, string | null | undefined])[]): ResolvedSetting | null => {
  for (const [source, raw] of candidates) {
    const value = present(raw);
    if (value !== null) return { value, source };
  }
  return null;
};

/**
 * Picks each setting from the strongest source that has it: the user setting, then the environment, then the registry
 * default. A source that holds only blanks is skipped, so clearing a user setting returns to the weaker source.
 *
 * @param input The chains and the three layers.
 */
export const resolveConnection = (input: ResolveConnectionInput): ResolvedConnection => {
  const layers = [
    ["user", input.user],
    ["environment", input.environment],
    ["default", input.registry],
  ] as const;
  const endpoints = Object.fromEntries(
    ENDPOINT_KEYS.map((key) => [key, firstSetting(layers.map(([source, layer]) => [source, layer[key]] as const))]),
  ) as Record<EndpointKey, ResolvedSetting | null>;
  return {
    ...endpoints,
    indexerUrl: firstSetting(layers.map(([source, layer]) => [source, layer.indexerUrl] as const)),
    rpcUrls: Object.fromEntries(
      input.chainIds.map((chainId) => [chainId, firstSetting(layers.map(([source, layer]) => [source, layer.rpcUrls?.[chainId]] as const))]),
    ),
    msgboardUrls: Object.fromEntries(
      input.chainIds.map((chainId) => [chainId, firstSetting(layers.map(([source, layer]) => [source, present(layer.msgboardUrls?.[chainId]) ?? layer.msgboardUrl] as const))]),
    ),
  };
};

/**
 * The msgboard node in force for a chain: its own entry, else the single one.
 *
 * @param resolved The settings in force.
 * @param chainId The chain.
 */
export const boardUrlOf = (resolved: Pick<ResolvedConnection, "msgboardUrl" | "msgboardUrls">, chainId: number): ResolvedSetting | null =>
  resolved.msgboardUrls?.[chainId] ?? resolved.msgboardUrl;

/**
 * Moves a single stored msgboard node to every chain of the pair (owner, quote 87: the node is set per chain), and
 * clears the single value, so a chain reset later falls back to the default and not to the old shared node. A chain
 * that already has its own node keeps it.
 *
 * @param settings The user's settings.
 * @param chainIds The chains of the pair.
 */
export const migrateBoardUrls = (settings: ConnectionSettings, chainIds: readonly number[]): ConnectionSettings => {
  const single = present(settings.msgboardUrl);
  if (single === null) return settings;
  const own = settings.msgboardUrls ?? {};
  return { ...settings, msgboardUrl: null, msgboardUrls: { ...Object.fromEntries(chainIds.map((chainId) => [chainId, single])), ...own } };
};

/** The words for a source, for the settings screens. */
export const describeSource = (source: SettingSource): string => {
  if (source === "user") return "set by you";
  if (source === "environment") return "from the environment";
  return "default";
};

/** The result of reading a URL that the user typed. */
export type ParsedUrl = { readonly ok: true; readonly url: string } | { readonly ok: false; readonly message: string };

/** The kind of service that a URL names. */
export type UrlPurpose = "rpc" | "indexer";

/**
 * Checks a URL that the user typed. The URL must use http or https and must hold no space, quote or backslash,
 * because the macOS Keychain store cannot hold those. The message never repeats the URL, because it can hold a key.
 * An indexer URL loses a trailing slash.
 *
 * @param text What the user typed.
 * @param purpose Which service the URL names, for the wording of the message.
 */
export const parseConnectionUrl = (text: string, purpose: UrlPurpose): ParsedUrl => {
  const trimmed = text.trim();
  const service = purpose === "rpc" ? "RPC" : "indexer";
  if (/[\s"'\\]/.test(trimmed)) return { ok: false, message: `The ${service} URL must not hold a space, a quote or a backslash.` };
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, message: `The ${service} URL is not a URL. Start it with http:// or https://.` };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, message: `The ${service} URL must start with http:// or https://.` };
  }
  return { ok: true, url: purpose === "indexer" ? trimmed.replace(/\/+$/, "") : trimmed };
};

/**
 * The pieces of a URL that can be a secret: the whole URL, the user name, the password, the path and each query value.
 * Pass them to the redactor with the other known secrets.
 *
 * @param url A URL, possibly with a key inside.
 */
export const urlSecrets = (url: string): readonly string[] => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [url];
  }
  // Which pieces may become known secrets is decided here (see isRegistrableSecret): the password and the value of a key
  // parameter count at any length; the user name, the path and a plain query value only when they look like a key, so
  // a user name such as "user" or a path such as "eth" never wipes those words from messages.
  const path = parsed.pathname.replace(/^\/+/, "");
  const marked = [parsed.password, ...[...parsed.searchParams].filter(([name]) => SECRET_PARAMETER.test(name)).map(([, value]) => value)];
  const plain = [parsed.username, path, parsed.search.replace(/^\?/, ""), ...[...parsed.searchParams].filter(([name]) => !SECRET_PARAMETER.test(name)).map(([, value]) => value)];
  return [
    url,
    ...marked.filter((piece) => isRegistrableSecret(piece, { marked: true })),
    ...plain.filter((piece) => isRegistrableSecret(piece)),
  ];
};

/**
 * A query parameter whose value is a secret by its name: the words match anywhere in the name, so api_key, api_key_id,
 * dkey, keys, tokenId, access_token, auth_code, pwd, pass, sig, X-Signature, credential and jwt all count. The value is
 * then registered at any length; the redactor removes it only as a whole token, so it never wipes parts of words.
 */
const SECRET_PARAMETER = /key|token|secret|pass|pwd|auth|sig|credential|jwt/i;

/**
 * Removes every secret part of the given URLs from a text, and the other secret shapes that the redactor knows.
 * Use it on every log line and every error message that can mention a connection.
 *
 * @param text The text to clean.
 * @param urls The URLs in use.
 */
export const redactConnectionText = (text: string, urls: readonly string[]): string =>
  redactSecrets(text, urls.flatMap(urlSecrets));

/**
 * A URL for a screen: the scheme and the host stay, and everything after the host shows only as stars and its last four
 * characters. The user name and the password never show.
 *
 * @param url The URL. A text that is not a URL shows as a masked secret.
 */
export const maskUrl = (url: string): string => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return maskSecret(url);
  }
  const rest = `${parsed.pathname.replace(/^\/+/, "")}${parsed.search}`;
  return rest === "" ? parsed.origin : `${parsed.origin}/${maskSecret(rest)}`;
};

/** The result of reading an endpoint that the user typed. */
export type NormalizedEndpoint =
  | { readonly ok: true; readonly url: string; readonly warning: "insecure-on-secure-page" | null }
  | { readonly ok: false; readonly reason: string };

/**
 * Reads an endpoint that the user typed. The URL must use http or https. It must hold no user name, password, query or
 * fragment. One trailing slash goes away, and a path prefix stays, so `https://x.example/api/` becomes
 * `https://x.example/api`. A plain http URL on an https page passes with a warning, because the browser blocks it.
 * The reason never repeats the text, because the text can hold a secret.
 *
 * @param input What the user typed and the protocol of the page that shows the setting.
 */
export const normalizeEndpoint = (input: { readonly text: string; readonly pageProtocol: "https:" | "http:" }): NormalizedEndpoint => {
  const trimmed = input.text.trim();
  if (/[\s"'\\]/.test(trimmed)) return { ok: false, reason: "The URL must not hold a space, a quote or a backslash." };
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, reason: "The text is not a URL. Start it with http:// or https://." };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { ok: false, reason: "The URL must start with http:// or https://." };
  if (parsed.username !== "" || parsed.password !== "") return { ok: false, reason: "The URL must not hold a user name or a password." };
  if (parsed.search !== "" || parsed.hash !== "") return { ok: false, reason: "The URL must not hold a query or a fragment." };
  const url = `${parsed.origin}${parsed.pathname.replace(/\/$/, "")}`;
  const insecure = input.pageProtocol === "https:" && parsed.protocol === "http:";
  return { ok: true, url, warning: insecure ? "insecure-on-secure-page" : null };
};
