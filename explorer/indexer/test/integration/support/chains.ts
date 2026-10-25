import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
  type WalletClient,
} from "viem";
import { REPOSITORY_ROOT } from "./processes";

/** The compiled test doubles of `test/contracts/Synthetic.sol`. */
export type SyntheticArtifacts = Record<string, { readonly abi: Abi; readonly bytecode: Hex }>;

const SYNTHETIC_NAMES = ["SyntheticBridge", "SyntheticToken", "SyntheticMediator", "SyntheticLightClient", "SyntheticGate", "SyntheticRegistry", "AdmitAllGate"];

/**
 * Compiles the test doubles with Foundry into a temporary output directory and loads them.
 * The first run compiles the whole repository once. Later runs reuse the cache.
 */
export const compileSyntheticContracts = (): SyntheticArtifacts => {
  const out = join(tmpdir(), "explorer-synthetic-out");
  execFileSync(
    "forge",
    ["build", "--root", REPOSITORY_ROOT, "--contracts", "explorer/indexer/test/contracts", "--out", out, "--cache-path", join(tmpdir(), "explorer-synthetic-cache")],
    { stdio: "ignore" },
  );
  return Object.fromEntries(
    SYNTHETIC_NAMES.map((name) => {
      const artifact = JSON.parse(readFileSync(join(out, "Synthetic.sol", `${name}.json`), "utf8")) as {
        abi: Abi;
        bytecode: { object: Hex };
      };
      return [name, { abi: artifact.abi, bytecode: artifact.bytecode.object }];
    }),
  );
};

/** A handle on one local chain: reads, writes with the unlocked accounts of Anvil, and deployments. */
export type ChainHandle = {
  readonly chainId: number;
  readonly url: string;
  readonly publicClient: PublicClient;
  readonly walletClient: WalletClient;
  /** The unlocked accounts of the node, in order. */
  readonly accounts: readonly Address[];
  readonly deploy: (name: string, args?: readonly unknown[]) => Promise<Address>;
  /** Sends a transaction to a contract function and waits for its receipt. */
  readonly send: (address: Address, name: string, functionName: string, args: readonly unknown[], account?: number) => Promise<TransactionReceipt>;
  /** Sends a transaction to a function of any ABI (for the real contracts) and waits for its receipt. */
  readonly write: (address: Address, abi: Abi, functionName: string, args: readonly unknown[], account?: number) => Promise<TransactionReceipt>;
  /** Mines empty blocks. */
  readonly mine: (count: number) => Promise<void>;
};

/**
 * Makes a handle on a running Anvil chain.
 *
 * @param chainId The chain identifier.
 * @param url The RPC URL.
 * @param artifacts The compiled test doubles.
 */
export const connectChain = async (chainId: number, url: string, artifacts: SyntheticArtifacts): Promise<ChainHandle> => {
  const chain = defineChain({ id: chainId, name: `local-${chainId}`, nativeCurrency: { name: "Coin", symbol: "COIN", decimals: 18 }, rpcUrls: { default: { http: [url] } } });
  const publicClient = createPublicClient({ chain, transport: http(url) });
  const walletClient = createWalletClient({ chain, transport: http(url) });
  const accounts = await walletClient.getAddresses();
  const artifact = (name: string) => {
    const found = artifacts[name];
    if (found === undefined) throw new Error(`unknown artifact ${name}`);
    return found;
  };
  return {
    chainId,
    url,
    publicClient,
    walletClient,
    accounts,
    deploy: async (name, args = []) => {
      const { abi, bytecode } = artifact(name);
      const hash = await walletClient.deployContract({ abi, bytecode, args, account: accounts[0] as Address, chain });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.contractAddress === null || receipt.contractAddress === undefined) throw new Error(`${name} did not deploy`);
      return receipt.contractAddress;
    },
    send: async (address, name, functionName, args, account = 0) => {
      const hash = await walletClient.writeContract({
        address,
        abi: artifact(name).abi,
        functionName,
        args,
        account: accounts[account] as Address,
        chain,
      });
      return publicClient.waitForTransactionReceipt({ hash });
    },
    write: async (address, abi, functionName, args, account = 0) => {
      const hash = await walletClient.writeContract({ address, abi, functionName, args, account: accounts[account] as Address, chain });
      return publicClient.waitForTransactionReceipt({ hash });
    },
    mine: async (count) => {
      await publicClient.request({ method: "anvil_mine" as never, params: [`0x${count.toString(16)}`] as never });
    },
  };
};
