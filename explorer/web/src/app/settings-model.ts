/**
 * The rules of the Settings sheet (spec: "Settings (owner)" and "Every endpoint is swappable"): which outside services
 * it lists, what each one's default is, and how the typed values become the stored settings. Pure, so the sheet only
 * draws and the rules have their own tests.
 */
import { registryLayer } from "@terminal/data/connection-runtime";
import { defaultBeaconUrl } from "@terminal/config/default-beacon";
import { defaultRpcUrl } from "@terminal/config/default-rpc";
import type { PairConfig } from "@terminal/model/types";
import {
  DEFAULT_INDEXER_URL,
  EMPTY_CONNECTION_SETTINGS,
  migrateBoardUrls,
  normalizeEndpoint,
  parseConnectionUrl,
  resolveConnection,
  type ConnectionLayer,
  type ConnectionSettings,
  type EndpointKey,
  type Pair,
} from "@zk-bridge/shared";
import { imageServerProblem } from "../bridge/image-server";
import { DEFAULT_IMAGE_SERVER } from "../bridge/image-source";
import type { WebConfiguration } from "../config/environment";
import { settingOf, userUrlOf, withoutUserUrl, withUserUrl, type ConnectionTarget } from "../views/ConnectionsView";
import type { ProbeKind } from "./service-probe";

/** One field of the sheet. */
export type SettingField = {
  readonly id: string;
  readonly label: string;
  /** The name inside the field, when it differs from the label. */
  readonly short?: string;
  readonly section: "rpc" | "beacon" | "images" | "services" | "boards";
  /** What the live check asks. */
  readonly probe: ProbeKind;
  /** The connection setting it writes, or null for the image server (stored on its own). */
  readonly target: ConnectionTarget | null;
  /** The chain whose icon the field shows (an RPC, a beacon API, a msgboard node). */
  readonly chainId?: number;
};

const service = (key: EndpointKey, label: string, probe: ProbeKind, short?: string): SettingField => ({
  id: key,
  label,
  ...(short === undefined ? {} : { short }),
  section: "services",
  probe,
  target: { kind: "endpoint", label, key },
});

/** The image server field. */
export const IMAGES_FIELD: SettingField = { id: "images", label: "Image server", short: "Images", section: "images", probe: { kind: "image" }, target: null };

/**
 * Every field, in the order of the sheet: an RPC per chain, a beacon API per chain, the image server, then the services.
 *
 * @param pair The pair, for its chains.
 */
export const settingFields = (pair: PairConfig): readonly SettingField[] => [
  ...[pair.first, pair.second].map(
    (chain): SettingField => ({
      id: `rpc:${chain.chainId}`,
      label: `${chain.name} RPC`,
      section: "rpc",
      probe: { kind: "rpc", chainId: chain.chainId },
      target: { kind: "rpc", label: `${chain.name} RPC`, chainId: chain.chainId },
      chainId: chain.chainId,
    }),
  ),
  // A beacon API per chain (owner: "we need to be able to configure different beacon endpoints in the settings").
  ...[pair.first, pair.second].map(
    (chain): SettingField => ({
      id: `beacon:${chain.chainId}`,
      label: `${chain.name} beacon API`,
      section: "beacon",
      probe: { kind: "beacon", chainId: chain.chainId },
      target: { kind: "beacon", label: `${chain.name} beacon API`, chainId: chain.chainId },
      chainId: chain.chainId,
    }),
  ),
  IMAGES_FIELD,
  { id: "indexer", label: "Indexer", section: "services", probe: { kind: "health" }, target: { kind: "indexer", label: "Indexer" } },
  service("backendUrl", "Prover", { kind: "health" }),
  service("archiveUrl", "Archive", { kind: "health" }),
  service("msgboardIndexerUrl", "Msgboard indexer", { kind: "health" }, "Board indexer"),
  // A msgboard node per chain (owner, quote 87). The probe names the chain, so two chains on one URL are checked twice,
  // each with its own result.
  ...[pair.first, pair.second].map(
    (chain): SettingField => ({
      id: `board:${chain.chainId}`,
      label: `${chain.name} msgboard node`,
      section: "boards",
      probe: { kind: "jsonrpc", chainId: chain.chainId },
      target: { kind: "board", label: `${chain.name} msgboard node`, chainId: chain.chainId },
      chainId: chain.chainId,
    }),
  ),
];

/** The values by field id. An empty text: nothing set. */
export type FieldValues = Readonly<Record<string, string>>;

const environmentLayer = (configuration: WebConfiguration): ConnectionLayer => ({
  indexerUrl: configuration.indexerUrl,
  backendUrl: configuration.backendUrl,
  msgboardIndexerUrl: configuration.msgboardIndexerUrl,
  archiveUrl: configuration.archiveUrl,
  msgboardUrl: configuration.msgboardUrl,
  rpcUrls: configuration.rpcUrls,
  beaconUrls: configuration.beaconUrls,
});

/**
 * The text of a field in a set of values; a field the set does not name has no text.
 *
 * @param values The values by field id.
 * @param id The field.
 */
export const textOf = (values: FieldValues, id: string): string => values[id] ?? "";

/**
 * Checks a URL for a connection field by the rule of its kind: an endpoint is normalized (and plain http on an https
 * page is named), an RPC or the indexer must be an http(s) URL.
 */
const checkUrl = (target: ConnectionTarget, text: string, pageProtocol: "https:" | "http:"): { readonly ok: true; readonly url: string; readonly insecure: boolean } | { readonly ok: false; readonly reason: string } => {
  if (target.kind === "endpoint" || target.kind === "board" || target.kind === "beacon") {
    const normalized = normalizeEndpoint({ text, pageProtocol });
    return normalized.ok ? { ok: true, url: normalized.url, insecure: normalized.warning !== null } : { ok: false, reason: normalized.reason };
  }
  const parsed = parseConnectionUrl(text, target.kind === "rpc" ? "rpc" : "indexer");
  return parsed.ok ? { ok: true, url: parsed.url, insecure: false } : { ok: false, reason: parsed.message };
};

/**
 * What each field holds when the user sets nothing: the build's value, else the registry's (the deployment's RPC, the
 * public RPC, the standard indexer address, the public beacon node), else nothing.
 *
 * @param input The fields, the pair, the configuration and the pair in its shared form (a live page has it).
 */
export const defaultValues = (input: { readonly fields: readonly SettingField[]; readonly pair: PairConfig; readonly configuration: WebConfiguration; readonly sharedPair?: Pair | undefined }): FieldValues => {
  const chainIds = [input.pair.first.chainId, input.pair.second.chainId];
  const registry: ConnectionLayer =
    input.sharedPair === undefined
      ? {
          indexerUrl: DEFAULT_INDEXER_URL,
          rpcUrls: Object.fromEntries(chainIds.map((chainId) => [chainId, defaultRpcUrl(chainId)])),
          beaconUrls: Object.fromEntries(chainIds.map((chainId) => [chainId, defaultBeaconUrl(chainId)])),
        }
      : registryLayer(input.sharedPair, defaultRpcUrl);
  const resolved = resolveConnection({ chainIds, user: EMPTY_CONNECTION_SETTINGS, environment: environmentLayer(input.configuration), registry });
  return Object.fromEntries(
    input.fields.map((field) => {
      if (field.target === null) return [field.id, DEFAULT_IMAGE_SERVER];
      return [field.id, settingOf(resolved, field.target)?.value ?? ""];
    }),
  );
};

/**
 * What each field shows now: the user's setting where there is one, else the default.
 *
 * @param fields The fields.
 * @param defaults Their defaults.
 * @param user The stored connection settings.
 * @param imageServer The image server in use.
 */
export const currentValues = (fields: readonly SettingField[], defaults: FieldValues, user: ConnectionSettings, imageServer: string): FieldValues =>
  Object.fromEntries(fields.map((field) => [field.id, field.target === null ? imageServer : (userUrlOf(user, field.target) ?? textOf(defaults, field.id))]));

/** Why a typed value cannot be used, or null. Empty is allowed for a field without a default (it stays unset). */
export const fieldProblem = (field: SettingField, text: string, defaultText: string): string | null => {
  const trimmed = text.trim();
  if (field.target === null) return imageServerProblem(trimmed);
  if (trimmed === "") return defaultText === "" ? null : "Enter a URL, or reset to the default.";
  const checked = checkUrl(field.target, trimmed, "http:");
  return checked.ok ? null : checked.reason;
};

/**
 * The protocol of a page, as the endpoint rules take it.
 *
 * @param protocol `location.protocol`.
 */
export const pageProtocolOf = (protocol: string): "https:" | "http:" => (protocol === "https:" ? "https:" : "http:");

/** The outcome of turning the typed values into settings. */
export type DraftOutcome = {
  /** The connection settings to store, when every field is usable. */
  readonly user: ConnectionSettings;
  /** The image server template to store, or null for the default. */
  readonly imageServer: string | null;
  /** The problem of each field that is not usable, by id. */
  readonly problems: Readonly<Record<string, string>>;
  /** Fields that the browser will block: plain http on an https page. */
  readonly insecure: readonly string[];
};

/**
 * The settings that the typed values make. A value equal to its default removes the user's setting, so a later change
 * of the default reaches this browser too.
 *
 * @param input The fields, the typed values, the defaults, the stored settings and the protocol of the page.
 */
export const settingsFromDrafts = (input: {
  readonly fields: readonly SettingField[];
  readonly drafts: FieldValues;
  readonly defaults: FieldValues;
  readonly user: ConnectionSettings;
  readonly pageProtocol: "https:" | "http:";
}): DraftOutcome => {
  // A saved single msgboard node moves to every chain first, so a chain set back to its default really returns to it.
  let user = migrateBoardUrls(input.user, input.fields.flatMap((field) => (field.target?.kind === "board" ? [field.target.chainId] : [])));
  let imageServer: string | null = null;
  const problems: Record<string, string> = {};
  const insecure: string[] = [];
  for (const field of input.fields) {
    const text = textOf(input.drafts, field.id).trim();
    const defaultText = textOf(input.defaults, field.id);
    if (field.target === null) {
      const problem = imageServerProblem(text);
      if (problem === null) imageServer = text === defaultText ? null : text;
      else problems[field.id] = problem;
      continue;
    }
    if (text === "" && defaultText !== "") {
      problems[field.id] = "Enter a URL, or reset to the default.";
      continue;
    }
    if (text === "" || text === defaultText) {
      user = withoutUserUrl(user, field.target);
      continue;
    }
    const checked = checkUrl(field.target, text, input.pageProtocol);
    if (!checked.ok) {
      problems[field.id] = checked.reason;
      continue;
    }
    if (checked.insecure) insecure.push(field.label);
    user = withUserUrl(user, field.target, checked.url);
  }
  return { user, imageServer, problems, insecure };
};
