import type { Pair, PairSide } from "../pairs.js";
import type { ProofDirection } from "../proof-message.js";
import type { RemoteEndpoint } from "./remote-endpoints.js";

/** The proving backend section of the prover configuration file. */
export type BackendSection =
  | {
      /** The remote graphics processor backend with one endpoint. Today the load balancing endpoint is the only mode. */
      readonly kind: "remote";
      readonly mode: { readonly mode: "load-balancing" };
      readonly endpoint: string;
      /** The NAME of the variable that carries the key. The key itself never enters the file. */
      readonly apiKeyVariable: string;
    }
  | {
      /**
       * The remote backend with endpoints in priority order, such as a dedicated worker and then the serverless
       * endpoint. The prover moves to the next endpoint only when one cannot give a proof (`docs/gpu-prover.md`).
       */
      readonly kind: "remote";
      readonly mode: { readonly mode: "load-balancing" };
      readonly endpoints: readonly RemoteEndpoint[];
    }
  | {
      /**
       * The development backend. Only a local chain accepts its proofs. It is for local testing only: no setting
       * chooses it unless a test or the end-to-end run asks for it by name.
       */
      readonly kind: "oracle";
      readonly keyVariable: string;
    }
  | {
      /** The production backend that proves on the local processor, from two compiled program files. */
      readonly kind: "sp1";
      readonly lightClientElfPath: string;
      readonly observationElfPath: string;
    };

/**
 * Where the prover also sends each finished package, besides standard output. The bearer token itself never enters the
 * file: `bearerVariable` is the NAME of the variable that holds it.
 */
export interface HandoffSection {
  readonly webhookUrl: string;
  readonly bearerVariable: string;
}

/** Settings of the route that do not come from the pair. */
export interface RouteOptions {
  /** A directory where the prover keeps the beacon states it fetched and verified (`source.state_cache_dir`). */
  readonly stateCacheDirectory?: string;
  /**
   * A directory of `eth_getProof` answers that the runner fetched near the tip of the destination chain
   * (`destination.proof_cache_dir`). The `opening-proof` command reads it before it asks the node, and verifies what it
   * reads. See `proof-cache.ts`.
   */
  readonly proofCacheDirectory?: string;
  /**
   * The handoff archive of the route's source chain (`source.handoff_archive_urls`): base URLs that serve
   * `<base>/<chainId>/<period>.json`, asked last for the committee handoff update of a period no beacon node gives.
   */
  readonly handoffArchiveUrls?: readonly string[];
  /**
   * The fork proof archive of the route's source chain (`source.fork_proof_archive_urls`): base URLs that serve
   * `<base>/<chainId>/<stateRoot>.json`, asked by the `evidence` command for the fork proof of a source state before it
   * downloads the whole state (after a held state and the multiproof route). See `fork-proof-record.ts`.
   */
  readonly forkProofArchiveUrls?: readonly string[];
}

/** One direction of a pair, as the prover configuration file describes a route. */
export interface RouteDescription {
  readonly name: string;
  readonly source: PairSide;
  readonly destination: PairSide;
}

/** Names the route of a direction after the two sides, such as `ethereum_to_pulsechain`. */
export function describeRoute(pair: Pair, direction: ProofDirection): RouteDescription {
  const [first, second] = pair.sides;
  const [source, destination] = direction === "first-to-second" ? [first, second] : [second, first];
  return { name: `${source.name}_to_${destination.name}`, source, destination };
}

/**
 * The chain kind that the prover names for the source chain, by chain identifier. Each testnet has its own kind,
 * because its genesis validators root and fork table differ from mainnet.
 */
const PROVER_CHAIN_KINDS = {
  1: "ethereum",
  369: "pulsechain",
  11155111: "sepolia",
  943: "pulsechain-testnet-v4",
} as const satisfies Readonly<Record<number, string>>;

/** A value that would break out of a quoted string in the file. */
const UNSAFE_TEXT = /["\\\n\r]/;

function quoted(value: string, field: string): string {
  if (UNSAFE_TEXT.test(value)) throw new Error(`${field} holds a character that the prover configuration cannot carry`);
  return `"${value}"`;
}

function backendLines(backend: BackendSection): readonly string[] {
  if (backend.kind === "sp1") {
    return [
      'backend = "sp1"',
      `sp1_elf_path = ${quoted(backend.lightClientElfPath, "light client program path")}`,
      `sp1_observation_elf_path = ${quoted(backend.observationElfPath, "observation program path")}`,
    ];
  }
  if (backend.kind === "oracle") return ['backend = "oracle"', `oracle_key_env = ${quoted(backend.keyVariable, "oracle key variable")}`];
  // The only mode today is the load balancing endpoint. A queue mode adds its keys here.
  // RunPod ends a request after 330 s. Three tries of 360 s, with their pauses, stay inside a job limit of 1800 s. An
  // endpoint of a list may set its own values; these are the defaults for the ones that do not.
  const limits = ["remote_timeout_seconds = 360", "remote_attempts = 3"];
  if ("endpoints" in backend) return ['backend = "remote"', ...limits, ...backend.endpoints.flatMap(endpointLines)];
  return [
    'backend = "remote"',
    `remote_url = ${quoted(backend.endpoint, "remote endpoint")}`,
    `remote_api_key_env = ${quoted(backend.apiKeyVariable, "remote key variable")}`,
    ...limits,
  ];
}

/** One `[[prover.remote_endpoints]]` table. It stays inside the `[prover]` section: the next header ends it. */
function endpointLines(endpoint: RemoteEndpoint): readonly string[] {
  const lines = [
    "",
    "[[prover.remote_endpoints]]",
    `label = ${quoted(endpoint.label, "remote endpoint label")}`,
    `url = ${quoted(endpoint.url, "remote endpoint")}`,
  ];
  if (endpoint.apiKeyVariable !== undefined) lines.push(`api_key_env = ${quoted(endpoint.apiKeyVariable, "remote key variable")}`);
  if (endpoint.readyWaitSeconds !== undefined) lines.push(`ready_wait_seconds = ${wholeNumber(endpoint.readyWaitSeconds, "ready wait")}`);
  if (endpoint.startWaitSeconds !== undefined) lines.push(`start_wait_seconds = ${wholeNumber(endpoint.startWaitSeconds, "start wait")}`);
  if (endpoint.timeoutSeconds !== undefined) lines.push(`timeout_seconds = ${wholeNumber(endpoint.timeoutSeconds, "timeout")}`);
  if (endpoint.attempts !== undefined) lines.push(`attempts = ${wholeNumber(endpoint.attempts, "attempts")}`);
  return lines;
}

function wholeNumber(value: number, field: string): string {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`the remote endpoint ${field} must be a whole number, zero or more`);
  return String(value);
}

function stateLines(stateUrls: readonly string[], cacheDirectory: string | undefined): readonly string[] {
  const lines: string[] = [];
  if (stateUrls.length > 0) {
    lines.push(`state_urls = [${stateUrls.map((url) => quoted(url, "source state url")).join(", ")}]`);
  }
  if (cacheDirectory !== undefined) lines.push(`state_cache_dir = ${quoted(cacheDirectory, "state cache directory")}`);
  return lines;
}

/** `handoff_urls` and `handoff_archive_urls` of the source. */
function handoffSourceLines(handoffUrls: readonly string[], archiveUrls: readonly string[]): readonly string[] {
  const lines: string[] = [];
  if (handoffUrls.length > 0) lines.push(`handoff_urls = [${handoffUrls.map((url) => quoted(url, "source handoff url")).join(", ")}]`);
  if (archiveUrls.length > 0) lines.push(`handoff_archive_urls = [${archiveUrls.map((url) => quoted(url, "handoff archive url")).join(", ")}]`);
  return lines;
}

/** `fork_proof_archive_urls` of the source. */
function forkProofArchiveLines(archiveUrls: readonly string[]): readonly string[] {
  if (archiveUrls.length === 0) return [];
  return [`fork_proof_archive_urls = [${archiveUrls.map((url) => quoted(url, "fork proof archive url")).join(", ")}]`];
}

/**
 * `header_rpc_urls` of one side: the endpoints that the prover asks for the raw header when the main RPC lacks
 * `debug_getRawHeader`. The `opening-proof` command reads them on the destination, the `evidence` command on the source
 * (a Gloas source block).
 */
function headerLines(headerRpcUrls: readonly string[], side: "source" | "destination"): readonly string[] {
  if (headerRpcUrls.length === 0) return [];
  return [`header_rpc_urls = [${headerRpcUrls.map((url) => quoted(url, `${side} header rpc endpoint`)).join(", ")}]`];
}

/**
 * `light_client_start_block` of the destination: where the prover starts its scan for the heads that the light client
 * stored. After a bridge redeploy that kept the light client this is before `start_block`, and a scan from `start_block`
 * misses the stored heads that the block hash row of an early message needs.
 */
function lightClientStartLines(block: number | undefined): readonly string[] {
  return block === undefined ? [] : [`light_client_start_block = ${block}`];
}

/** `proof_cache_dir` of the destination: the proof cache that the `opening-proof` command reads first. */
function proofCacheLines(directory: string | undefined): readonly string[] {
  return directory === undefined ? [] : [`proof_cache_dir = ${quoted(directory, "proof cache directory")}`];
}

function handoffLines(handoff: HandoffSection | undefined): readonly string[] {
  if (handoff === undefined) return ['targets = ["stdout"]'];
  return [
    'targets = ["stdout", "webhook"]',
    `webhook_url = ${quoted(handoff.webhookUrl, "webhook url")}`,
    `webhook_bearer_env = ${quoted(handoff.bearerVariable, "webhook bearer variable")}`,
  ];
}

/**
 * Renders the prover configuration file for one route. The file holds the endpoints, which can carry keys, so the
 * caller writes it with mode 0600 and deletes it when the command ends. It never holds the proving key: the backend
 * section names a variable.
 *
 * @param route The route and its two sides.
 * @param backend The backend for a `prove` run, or null for the commands that need none.
 * @param handoff Also send each package to a webhook. Used only with a backend.
 * @param options The state cache directory and the proof cache directory of the route, when the caller keeps them.
 * @throws Error when a value holds a quote, a backslash or a line break.
 */
export function renderProverConfig(
  route: RouteDescription,
  backend: BackendSection | null,
  handoff?: HandoffSection,
  options: RouteOptions = {},
): string {
  const { source, destination } = route;
  const chainKind = (PROVER_CHAIN_KINDS as Readonly<Record<number, string>>)[source.chainId];
  if (chainKind === undefined) {
    throw new Error(`the source chain id ${source.chainId} is not a chain kind that the prover knows`);
  }
  if (source.beaconUrl === null) throw new Error(`the ${source.name} side has no beacon endpoint`);
  const lines: string[] = [];
  if (backend !== null) lines.push("[prover]", ...backendLines(backend), "", "[handoff]", ...handoffLines(handoff), "");
  lines.push(
    `[routes.${route.name}.source]`,
    `chain_id = ${source.chainId}`,
    `chain = ${quoted(chainKind, "source chain")}`,
    `beacon_url = ${quoted(source.beaconUrl, "source beacon endpoint")}`,
    `rpc_url = ${quoted(source.rpcUrl, "source rpc endpoint")}`,
    `bridge = ${quoted(source.contracts.bridge, "source bridge")}`,
    ...stateLines(source.stateUrls ?? [], options.stateCacheDirectory),
    ...headerLines(source.headerRpcUrls ?? [], "source"),
    ...handoffSourceLines(source.handoffUrls ?? [], options.handoffArchiveUrls ?? []),
    ...forkProofArchiveLines(options.forkProofArchiveUrls ?? []),
    "",
    `[routes.${route.name}.destination]`,
    `chain_id = ${destination.chainId}`,
    `rpc_url = ${quoted(destination.rpcUrl, "destination rpc endpoint")}`,
    `light_client = ${quoted(destination.contracts.lightClient, "destination light client")}`,
    `bridge = ${quoted(destination.contracts.bridge, "destination bridge")}`,
    `start_block = ${destination.startBlock}`,
    ...lightClientStartLines(destination.lightClientStartBlock),
    ...headerLines(destination.headerRpcUrls ?? [], "destination"),
    ...proofCacheLines(options.proofCacheDirectory),
    "",
  );
  return lines.join("\n");
}
