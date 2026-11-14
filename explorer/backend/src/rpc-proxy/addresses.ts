import { toFunctionSelector } from "viem";
import { z } from "zod";

/**
 * The zkb.fi contracts of each chain, for the rules of rpc.zkb.fi (`rules.ts`). Three sources:
 *
 * - the deployment files: every address of a chain's entry (bridge, routers, mediator, token factory, wrapped native,
 *   gate, light client, fork registry, msgboard, and whatever a later deployment adds), read once at start;
 * - the chain: what a gate names (its fork registry and its beacon roots contract) and what a fork registry names (its
 *   own light client), read again every refresh, because a fork registry can be replaced without a new deployment file;
 * - the indexer: every token it knows (`GET /api/tokens`), so a bridged token's reads and logs pass.
 *
 * A source that fails keeps what it gave last time; the deployment files never go away.
 */

/** The contracts that one deployment file names for one chain. Addresses are lower case. */
export type DeploymentChain = {
  readonly chainId: number;
  readonly addresses: readonly string[];
  readonly gates: readonly string[];
  readonly forkRegistries: readonly string[];
};

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ZERO = `0x${"0".repeat(40)}`;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Every address found anywhere inside a value (strings, arrays and objects), lower case. */
function addressesIn(value: unknown): string[] {
  if (typeof value === "string") return ADDRESS.test(value) ? [value.toLowerCase()] : [];
  if (Array.isArray(value)) return value.flatMap(addressesIn);
  if (isObject(value)) return Object.values(value).flatMap(addressesIn);
  return [];
}

/**
 * The chains of a deployment file: each object with a numeric `chain_id` (such as `chain_a` and `chain_b`), with all the
 * addresses inside it.
 */
export function deploymentChains(deployment: unknown): DeploymentChain[] {
  if (Array.isArray(deployment)) return deployment.flatMap(deploymentChains);
  if (!isObject(deployment)) return [];
  if (typeof deployment.chain_id !== "number") return Object.values(deployment).flatMap(deploymentChains);
  return [
    {
      chainId: deployment.chain_id,
      addresses: [...new Set(addressesIn(deployment))],
      gates: addressesIn(deployment.gate),
      forkRegistries: addressesIn(deployment.fork_registry),
    },
  ];
}

/** Posts a JSON-RPC body to the node of a chain and answers the parsed JSON. */
export type NodePost = (chainId: number, body: string) => Promise<unknown>;

const answerSchema = z.array(z.object({ id: z.number(), result: z.string().optional() }).loose());

/** One address view to read: `to.signature()`, which answers an address. */
type View = { readonly to: string; readonly signature: string };

/** Reads address views in one batch: the address each one answers, or null when it failed or answered none. */
async function readAddressViews(post: NodePost, chainId: number, views: readonly View[]): Promise<(string | null)[]> {
  if (views.length === 0) return [];
  const body = views.map((view, id) => ({ jsonrpc: "2.0", id, method: "eth_call", params: [{ to: view.to, data: toFunctionSelector(view.signature) }, "latest"] }));
  const answers = answerSchema.parse(await post(chainId, JSON.stringify(body)));
  return views.map((_, id) => {
    const result = answers.find((answer) => answer.id === id)?.result;
    if (result === undefined || !/^0x[0-9a-fA-F]{64}$/.test(result)) return null;
    const address = `0x${result.slice(-40)}`.toLowerCase();
    return address === ZERO ? null : address;
  });
}

const present = (values: readonly (string | null)[]): string[] => values.filter((value): value is string => value !== null);

/**
 * The contracts that the gates and fork registries of a chain name: each gate's `forkRegistry()` and `beaconRoots()`,
 * and the `lightClient()` of each registry (the deployment's, then those that only a gate names).
 *
 * @throws When the node cannot be read or answers something that is not a batch.
 */
export async function discoverContracts(post: NodePost, chain: DeploymentChain): Promise<string[]> {
  const registryViews = chain.gates.map((gate) => ({ to: gate, signature: "forkRegistry()" }));
  const otherViews = [...chain.gates.map((gate) => ({ to: gate, signature: "beaconRoots()" })), ...chain.forkRegistries.map((registry) => ({ to: registry, signature: "lightClient()" }))];
  const answers = await readAddressViews(post, chain.chainId, [...registryViews, ...otherViews]);
  const registries = present(answers.slice(0, registryViews.length));
  const unread = [...new Set(registries)].filter((registry) => !chain.forkRegistries.includes(registry));
  const lightClients = await readAddressViews(post, chain.chainId, unread.map((registry) => ({ to: registry, signature: "lightClient()" })));
  return [...new Set([...present(answers), ...present(lightClients)])];
}

const tokensSchema = z.object({ tokens: z.array(z.object({ chainId: z.number(), address: z.string() }).loose()) }).loose();

/**
 * The tokens that the indexer knows, by chain: its `GET /api/tokens`.
 *
 * @throws When the indexer does not answer 200 with a token list.
 */
export async function readIndexerTokens(fetchFunction: typeof fetch, indexerUrl: string, timeoutMilliseconds: number): Promise<Map<number, string[]>> {
  const response = await fetchFunction(`${indexerUrl.replace(/\/+$/, "")}/api/tokens`, { signal: AbortSignal.timeout(timeoutMilliseconds) });
  if (response.status !== 200) throw new Error(`the indexer answered ${response.status}`);
  const { tokens } = tokensSchema.parse(await response.json());
  const byChain = new Map<number, string[]>();
  for (const token of tokens) {
    if (!ADDRESS.test(token.address)) continue;
    byChain.set(token.chainId, [...(byChain.get(token.chainId) ?? []), token.address.toLowerCase()]);
  }
  return byChain;
}

/** What {@link createAddressBook} needs. */
export type AddressBookInput = {
  /** The chains served. */
  readonly chainIds: readonly number[];
  /** The chains of the deployment files. */
  readonly deployment: readonly DeploymentChain[];
  /** The extra contracts of each served chain (the configuration's, global and per chain). */
  readonly extraContracts: (chainId: number) => readonly string[];
  readonly post: NodePost;
  /** Reads the indexer's tokens. Absent without an indexer. */
  readonly readTokens?: () => Promise<Map<number, string[]>>;
};

/** The current contracts of each chain, and the refresh that reads the chain and the indexer again. */
export type AddressBook = {
  /** The zkb.fi contracts of a served chain, lower case. */
  contractsOf(chainId: number): ReadonlySet<string>;
  /** Reads the gates, the registries and the indexer again. Resolves with the sources that failed (empty when none did). */
  refresh(): Promise<string[]>;
};

/** Builds the address book. Until the first refresh it holds the deployment files and the extra contracts only. */
export function createAddressBook(input: AddressBookInput): AddressBook {
  const fixed = new Map<number, Set<string>>();
  for (const chainId of input.chainIds) {
    const fromDeployment = input.deployment.filter((chain) => chain.chainId === chainId).flatMap((chain) => chain.addresses);
    fixed.set(chainId, new Set([...fromDeployment, ...input.extraContracts(chainId).map((address) => address.toLowerCase())]));
  }
  const discovered = new Map<number, readonly string[]>();
  let tokens = new Map<number, string[]>();
  const merged = new Map<number, Set<string>>();
  const merge = () => {
    for (const chainId of input.chainIds) merged.set(chainId, new Set([...(fixed.get(chainId) as Set<string>), ...(discovered.get(chainId) ?? []), ...(tokens.get(chainId) ?? [])]));
  };
  merge();
  return {
    contractsOf: (chainId) => merged.get(chainId) ?? new Set(),
    async refresh() {
      const failed: string[] = [];
      for (const chain of input.deployment.filter((candidate) => input.chainIds.includes(candidate.chainId))) {
        if (chain.gates.length === 0 && chain.forkRegistries.length === 0) continue;
        try {
          discovered.set(chain.chainId, await discoverContracts(input.post, chain));
        } catch (error) {
          failed.push(`chain ${chain.chainId}: ${(error as Error).message}`);
        }
      }
      if (input.readTokens !== undefined) {
        try {
          tokens = await input.readTokens();
        } catch (error) {
          failed.push(`indexer tokens: ${(error as Error).message}`);
        }
      }
      merge();
      return failed;
    },
  };
}
