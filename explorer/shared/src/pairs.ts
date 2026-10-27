import { z } from "zod";
import type { Address } from "viem";
import { normalizeAddress } from "./address.js";
import type { BaseFeeSupport } from "./delivery-terms.js";
import { defaultFinalitySeconds } from "./status.js";

/** The contract addresses of one side of a pair, lowercase. */
export type SideContracts = {
  readonly bridge: Address;
  readonly mediator: Address;
  readonly tokenFactory: Address;
  readonly nativeRouter: Address;
  readonly wrappedNative: Address;
  readonly gate: Address;
  readonly lightClient: Address;
  /** Optional: a `DeliveryRouter`. It emits no events, so the indexer does not read it. */
  readonly deliveryRouter: Address | null;
  /** Optional: a `ForkRegistry`, deployed on PulseChain only. */
  readonly forkRegistry: Address | null;
};

/** One chain of a pair. */
export type PairSide = {
  /** The name of the side, such as `ethereum`. It is a label for people and for Ponder chain names. */
  readonly name: string;
  readonly chainId: number;
  /** The execution layer RPC endpoint. */
  readonly rpcUrl: string;
  /** The beacon node endpoint, or null when none is configured. The indexer does not need it. */
  readonly beaconUrl: string | null;
  /** The first block to index: the block before the deployment. */
  readonly startBlock: number;
  /** Optional. `none` for a chain whose `block.basefee` is 0 (BSC). The tip guard then refuses `EXCLUDE_PRIORITY`. Default: `reported`. */
  readonly baseFee?: BaseFeeSupport;
  /** Seconds after which a send counts as waiting for finality. */
  readonly finalitySeconds: number;
  readonly contracts: SideContracts;
};

/** Two chains joined one to one. */
export type Pair = {
  readonly name: string;
  readonly sides: readonly [PairSide, PairSide];
};

/** The definition of a known pair, without endpoints or addresses. */
export type PairDefinition = {
  readonly name: string;
  readonly sides: readonly [{ readonly name: string; readonly chainId: number }, { readonly name: string; readonly chainId: number }];
};

/** The pairs that the explorer knows by name. */
export const PAIR_DEFINITIONS: readonly PairDefinition[] = [
  {
    name: "eth-pls",
    sides: [
      { name: "ethereum", chainId: 1 },
      { name: "pulsechain", chainId: 369 },
    ],
  },
  {
    name: "sepolia-pls943",
    sides: [
      { name: "sepolia", chainId: 11155111 },
      { name: "pulsechain-testnet-v4", chainId: 943 },
    ],
  },
];

/** The pair that runs when none is named. */
export const DEFAULT_PAIR_NAME = "eth-pls";

const addressField = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "must be a 20 byte hex address");

/** One chain section of the deployment file that `docker/deploy.sh` writes. */
const deploymentChainSchema = z.object({
  chain_id: z.number().int().positive(),
  rpc_url: z.string().optional(),
  bridge: addressField,
  mediator: addressField,
  token_factory: addressField,
  native_router: addressField,
  wrapped_native: addressField,
  gate: addressField,
  light_client: addressField,
  delivery_router: addressField.nullish(),
  fork_registry: addressField.nullish(),
  start_block: z.number().int().nonnegative(),
});

/**
 * The deployment file: any number of chain sections, each an object with the fields above. `docker/deploy.sh` names
 * them `chain_a` and `chain_b`. A section is matched to a pair side by its `chain_id`, not by its key.
 */
export const deploymentFileSchema = z.record(z.string(), z.unknown());

/** The environment variables that the registry reads. */
export type RegistryEnvironment = Readonly<Record<string, string | undefined>>;

/**
 * The name of the RPC variable of a chain.
 *
 * @param chainId The chain identifier.
 */
export const rpcVariableName = (chainId: number): string => `EXPLORER_RPC_URL_${chainId}`;
/**
 * The name of the beacon variable of a chain.
 *
 * @param chainId The chain identifier.
 */
export const beaconVariableName = (chainId: number): string => `EXPLORER_BEACON_URL_${chainId}`;
/**
 * The name of the finality override variable of a chain.
 *
 * @param chainId The chain identifier.
 */
export const finalityVariableName = (chainId: number): string => `EXPLORER_FINALITY_SECONDS_${chainId}`;

/** Options for `loadPair`. */
export type LoadPairOptions = {
  /** The pair name. Default: `eth-pls`. */
  readonly pairName?: string;
  /** The environment with the endpoints. */
  readonly environment: RegistryEnvironment;
  /** The parsed deployment file. */
  readonly deployment: unknown;
  /**
   * Whether a chain must have an RPC endpoint. Default true. With false, a chain that has none gets `rpcUrl` "", so a
   * dashboard can start and let the user set the endpoint later.
   */
  readonly requireRpcUrl?: boolean;
};

const findDefinition = (pairName: string): PairDefinition => {
  const definition = PAIR_DEFINITIONS.find((candidate) => candidate.name === pairName);
  if (definition === undefined) {
    const known = PAIR_DEFINITIONS.map((candidate) => candidate.name).join(", ");
    throw new Error(`unknown pair "${pairName}" (known: ${known})`);
  }
  return definition;
};

const findChainSection = (deployment: unknown, chainId: number): z.infer<typeof deploymentChainSchema> => {
  const sections = deploymentFileSchema.parse(deployment);
  const parsed = Object.values(sections)
    .map((section) => deploymentChainSchema.safeParse(section))
    .filter((result) => result.success)
    .map((result) => result.data)
    .filter((section) => section.chain_id === chainId);
  if (parsed.length !== 1) {
    throw new Error(`the deployment file must hold exactly one valid section for chain ${chainId}, found ${parsed.length}`);
  }
  return parsed[0] as z.infer<typeof deploymentChainSchema>;
};

const optionalAddress = (value: string | null | undefined): Address | null =>
  value === undefined || value === null ? null : normalizeAddress(value);

const finalityOf = (environment: RegistryEnvironment, chainId: number): number => {
  const override = environment[finalityVariableName(chainId)];
  if (override === undefined || override === "") return defaultFinalitySeconds(chainId);
  const seconds = Number(override);
  if (!Number.isInteger(seconds) || seconds < 0) throw new Error(`${finalityVariableName(chainId)} must be a whole number`);
  return seconds;
};

const buildSide = (
  definition: { readonly name: string; readonly chainId: number },
  options: LoadPairOptions,
): PairSide => {
  const section = findChainSection(options.deployment, definition.chainId);
  const rpcUrl = options.environment[rpcVariableName(definition.chainId)] ?? section.rpc_url;
  if ((rpcUrl === undefined || rpcUrl === "") && options.requireRpcUrl !== false) {
    throw new Error(`set ${rpcVariableName(definition.chainId)} to the RPC endpoint of chain ${definition.chainId}`);
  }
  const beaconUrl = options.environment[beaconVariableName(definition.chainId)];
  return {
    name: definition.name,
    chainId: definition.chainId,
    rpcUrl: rpcUrl ?? "",
    beaconUrl: beaconUrl === undefined || beaconUrl === "" ? null : beaconUrl,
    startBlock: section.start_block,
    finalitySeconds: finalityOf(options.environment, definition.chainId),
    contracts: {
      bridge: normalizeAddress(section.bridge),
      mediator: normalizeAddress(section.mediator),
      tokenFactory: normalizeAddress(section.token_factory),
      nativeRouter: normalizeAddress(section.native_router),
      wrappedNative: normalizeAddress(section.wrapped_native),
      gate: normalizeAddress(section.gate),
      lightClient: normalizeAddress(section.light_client),
      deliveryRouter: optionalAddress(section.delivery_router),
      forkRegistry: optionalAddress(section.fork_registry),
    },
  };
};

/**
 * Builds a pair from its definition, the environment and the deployment file.
 *
 * @param options The pair name, the environment and the parsed deployment file.
 * @throws When the pair is unknown, a section is missing or invalid, or an RPC endpoint is missing.
 */
export const loadPair = (options: LoadPairOptions): Pair => {
  const definition = findDefinition(options.pairName ?? DEFAULT_PAIR_NAME);
  return {
    name: definition.name,
    sides: [buildSide(definition.sides[0], options), buildSide(definition.sides[1], options)],
  };
};

/**
 * The other side of a pair.
 *
 * @param pair The pair.
 * @param chainId The chain identifier of one side.
 * @throws When the chain is not in the pair.
 */
export const otherSide = (pair: Pair, chainId: number): PairSide => {
  const [first, second] = pair.sides;
  if (first.chainId === chainId) return second;
  if (second.chainId === chainId) return first;
  throw new Error(`chain ${chainId} is not in pair ${pair.name}`);
};

/**
 * The side of a pair for a chain.
 *
 * @param pair The pair.
 * @param chainId The chain identifier.
 * @throws When the chain is not in the pair.
 */
export const sideOf = (pair: Pair, chainId: number): PairSide => otherSide(pair, otherSide(pair, chainId).chainId);

/**
 * The public description of a pair for an API: no endpoint URLs, because they can carry keys.
 *
 * @param pair The pair.
 */
export const describePair = (pair: Pair) => ({
  name: pair.name,
  sides: pair.sides.map((side) => ({
    name: side.name,
    chainId: side.chainId,
    startBlock: side.startBlock,
    finalitySeconds: side.finalitySeconds,
    contracts: side.contracts,
  })),
});
