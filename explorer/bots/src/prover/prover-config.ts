import type { Pair, PairSide, ProofDirection } from "@zk-bridge/shared";
import type { RemoteMode } from "../config/bot-config.ts";

/** The proving backend section of the prover configuration file. */
export type BackendSection =
  | {
      /** The remote graphics processor backend. Today the load balancing endpoint is the only mode. */
      readonly kind: "remote";
      readonly mode: RemoteMode;
      readonly endpoint: string;
      /** The NAME of the variable that carries the key. The key itself never enters the file. */
      readonly apiKeyVariable: string;
    }
  | {
      /** The development backend. Only a local chain accepts its proofs. Tests use it. */
      readonly kind: "oracle";
      readonly keyVariable: string;
    };

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

/** A value that would break out of a quoted string in the file. */
const UNSAFE_TEXT = /["\\\n\r]/;

function quoted(value: string, field: string): string {
  if (UNSAFE_TEXT.test(value)) throw new Error(`${field} holds a character that the prover configuration cannot carry`);
  return `"${value}"`;
}

function backendLines(backend: BackendSection): readonly string[] {
  if (backend.kind === "oracle") return ['backend = "oracle"', `oracle_key_env = ${quoted(backend.keyVariable, "oracle key variable")}`];
  // The only mode today is the load balancing endpoint. A queue mode adds its keys here.
  return [
    'backend = "remote"',
    `remote_url = ${quoted(backend.endpoint, "remote endpoint")}`,
    `remote_api_key_env = ${quoted(backend.apiKeyVariable, "remote key variable")}`,
  ];
}

/**
 * Renders the prover configuration file for one route. The file holds the endpoints, which can carry keys, so the
 * caller writes it with mode 0600 and deletes it when the command ends. It never holds the proving key: the backend
 * section names a variable.
 *
 * @param route The route and its two sides.
 * @param backend The backend for a `prove` run, or null for the commands that need none.
 * @throws Error when a value holds a quote, a backslash or a line break.
 */
export function renderProverConfig(route: RouteDescription, backend: BackendSection | null): string {
  const { source, destination } = route;
  if (source.name !== "ethereum" && source.name !== "pulsechain") {
    throw new Error(`the source chain name "${source.name}" is not a chain kind that the prover knows`);
  }
  if (source.beaconUrl === null) throw new Error(`the ${source.name} side has no beacon endpoint`);
  const lines: string[] = [];
  if (backend !== null) lines.push("[prover]", ...backendLines(backend), "", "[handoff]", 'targets = ["stdout"]', "");
  lines.push(
    `[routes.${route.name}.source]`,
    `chain_id = ${source.chainId}`,
    `chain = ${quoted(source.name, "source chain")}`,
    `beacon_url = ${quoted(source.beaconUrl, "source beacon endpoint")}`,
    `rpc_url = ${quoted(source.rpcUrl, "source rpc endpoint")}`,
    `bridge = ${quoted(source.contracts.bridge, "source bridge")}`,
    "",
    `[routes.${route.name}.destination]`,
    `chain_id = ${destination.chainId}`,
    `rpc_url = ${quoted(destination.rpcUrl, "destination rpc endpoint")}`,
    `light_client = ${quoted(destination.contracts.lightClient, "destination light client")}`,
    `bridge = ${quoted(destination.contracts.bridge, "destination bridge")}`,
    `start_block = ${destination.startBlock}`,
    "",
  );
  return lines.join("\n");
}
