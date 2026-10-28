/**
 * The shared context of the end-to-end driver: the files that `e2e/deploy.sh` writes, the accounts of the public Anvil
 * mnemonic, and one viem client pair for each chain. Nothing here is secret: every key comes from the public mnemonic.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
  type WalletClient,
} from "viem";
import { mnemonicToAccount, type HDAccount } from "viem/accounts";

/** The published development mnemonic of Anvil. It holds no value. */
export const ANVIL_MNEMONIC = "test test test test test test test test test test test junk";

/** The account of each role, by index of the mnemonic. The first numbers match `e2e/env.sh`. */
export const ACCOUNT_INDEX = {
  deployer: 0,
  oracle: 1,
  runner: 2,
  recipient: 3,
  reward: 4,
  failedDelivery: 5,
  copier: 6,
  senderOne: 7,
  senderTwo: 8,
  recipientTwo: 9,
  recipientThree: 10,
  poster: 11,
} as const;

/** The name of a role of {@link ACCOUNT_INDEX}. */
export type Role = keyof typeof ACCOUNT_INDEX;

/** The account of a role. */
export const accountOf = (role: Role): HDAccount => mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: ACCOUNT_INDEX[role] });

/** One of the two chains: A is chain 1 and B is chain 369. */
export type Side = "a" | "b";

/** What `e2e/deploy.sh` wrote to `deployment.json` for one chain. */
export interface DeploymentSection {
  readonly chain_id: number;
  readonly rpc_url: string;
  readonly bridge: Address;
  readonly mediator: Address;
  readonly token_factory: Address;
  readonly native_router: Address;
  readonly wrapped_native: Address;
  readonly gate: Address;
  readonly light_client: Address;
  readonly delivery_router: Address;
  readonly start_block: number;
}

/** What `e2e/deploy.sh` wrote to `run.json`. */
export interface RunRecord {
  readonly tokens: { readonly a: Address; readonly blockableA: Address; readonly b: Address; readonly wrappedA: Address; readonly wrappedB: Address };
  readonly verifiers: { readonly a: Address; readonly b: Address };
  readonly programKey: Hex;
  readonly multicall3: Address;
  readonly beaconRoots: Address;
  readonly backend: "remote" | "oracle";
}

/**
 * Chooses what proves in the run. A RunPod key in the environment selects the real remote prover; no key selects the free
 * oracle prover. The endpoint of the remote prover has no default: it must come from `E2E_RUNPOD_URL`.
 *
 * @param environment The environment variables to read.
 * @throws Error when a key is set but `E2E_RUNPOD_URL` is not.
 */
export const backendOf = (environment: Readonly<Record<string, string | undefined>>): "oracle" | "remote" => {
  const apiKey = environment.RUNPOD_API_KEY;
  if (apiKey === undefined || apiKey === "") return "oracle";
  const endpoint = environment.E2E_RUNPOD_URL;
  if (endpoint === undefined || endpoint === "") throw new Error("RUNPOD_API_KEY is set, so E2E_RUNPOD_URL must name the RunPod endpoint");
  return "remote";
};

/** The two clients and the facts of one chain. */
export interface ChainContext {
  readonly side: Side;
  readonly chain: Chain;
  readonly rpcUrl: string;
  readonly deployment: DeploymentSection;
  readonly publicClient: PublicClient;
  /** A wallet client for an account of the public mnemonic. */
  readonly walletFor: (role: Role) => WalletClient;
}

/** Everything a stage needs. */
export interface Context {
  readonly stateDirectory: string;
  readonly repositoryRoot: string;
  readonly run: RunRecord;
  /** What proves in this run: see {@link backendOf}. */
  readonly backend: "oracle" | "remote";
  readonly a: ChainContext;
  readonly b: ChainContext;
  readonly beaconUrl: string;
  readonly proverBinary: string;
  readonly proverConfig: string;
}

const readJson = <Shape>(path: string): Shape => JSON.parse(readFileSync(path, "utf8")) as Shape;

const requiredVariable = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`the environment variable ${name} is not set`);
  return value;
};

const chainContext = (side: Side, deployment: DeploymentSection): ChainContext => {
  const rpcUrl = deployment.rpc_url;
  const chain = defineChain({
    id: deployment.chain_id,
    name: side === "a" ? "chain-a" : "chain-b",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl), pollingInterval: 400 }) as PublicClient;
  const walletFor = (role: Role): WalletClient => createWalletClient({ account: accountOf(role), chain, transport: http(rpcUrl) });
  return { side, chain, rpcUrl, deployment, publicClient, walletFor };
};

/**
 * Loads the context from the state directory (`E2E_STATE_DIR`).
 *
 * @throws Error when a file or an environment variable is missing.
 */
export const loadContext = (): Context => {
  const stateDirectory = requiredVariable("E2E_STATE_DIR");
  const repositoryRoot = join(import.meta.dir, "..", "..", "..");
  const deployment = readJson<{ chain_a: DeploymentSection; chain_b: DeploymentSection }>(join(stateDirectory, "deployment.json"));
  const run = readJson<RunRecord>(join(stateDirectory, "run.json"));
  return {
    stateDirectory,
    repositoryRoot,
    run,
    backend: backendOf(process.env),
    a: chainContext("a", deployment.chain_a),
    b: chainContext("b", deployment.chain_b),
    beaconUrl: process.env.E2E_BEACON ?? "http://127.0.0.1:39000",
    proverBinary: process.env.E2E_PROVER ?? join(repositoryRoot, "prover/target/release/zk-bridge-prover"),
    proverConfig: join(stateDirectory, "prover.toml"),
  };
};

/** The chain context of a side. */
export const chainOf = (context: Context, side: Side): ChainContext => (side === "a" ? context.a : context.b);

/** The other side. */
export const otherSide = (side: Side): Side => (side === "a" ? "b" : "a");

/** The route name of the prover configuration that starts on a side. */
export const routeFrom = (side: Side): string => (side === "a" ? "a_to_b" : "b_to_a");

/** The outcome of a transaction that the driver sent. */
export interface Sent {
  readonly hash: Hex;
  readonly receipt: TransactionReceipt;
  readonly gasUsed: bigint;
}

/** A transaction that reverted, with the hash for the trace. */
export class RevertedError extends Error {
  constructor(
    readonly label: string,
    readonly hash: Hex,
  ) {
    super(`${label} reverted (${hash})`);
    this.name = "RevertedError";
  }
}

/**
 * Sends a transaction from a role and waits for the receipt. The gas limit comes from the node's estimate plus a margin,
 * so a call that would revert fails here with the node's reason.
 *
 * @param chain The chain.
 * @param role The sender.
 * @param call The target, the data and the value. `gas` overrides the estimate.
 * @param label A name for error messages.
 * @throws RevertedError when the transaction is mined and reverts.
 */
export const sendFrom = async (
  chain: ChainContext,
  role: Role,
  call: { readonly to: Address; readonly data?: Hex; readonly value?: bigint; readonly gas?: bigint },
  label: string,
): Promise<Sent> => {
  const wallet = chain.walletFor(role);
  const account = accountOf(role);
  const gas =
    call.gas ??
    ((await chain.publicClient.estimateGas({ account, to: call.to, ...(call.data === undefined ? {} : { data: call.data }), ...(call.value === undefined ? {} : { value: call.value }) })) * 12n) / 10n;
  const hash = await wallet.sendTransaction({
    account,
    chain: chain.chain,
    to: call.to,
    gas,
    ...(call.data === undefined ? {} : { data: call.data }),
    ...(call.value === undefined ? {} : { value: call.value }),
  });
  const receipt = await chain.publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (receipt.status !== "success") throw new RevertedError(label, hash);
  return { hash, receipt, gasUsed: receipt.gasUsed };
};
