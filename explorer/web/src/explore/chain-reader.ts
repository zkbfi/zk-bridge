/**
 * Reads Explore needs from the chains themselves, through the user's RPC: a transaction and its receipt, a block, an
 * address's balance, nonce and code. A test replaces the module.
 */
import { explorerLinks } from "@terminal/config/chain-metadata";
import { beaconLightClientAbi } from "@zk-bridge/shared";
import { rpcTransport } from "../app/rpc-transport";
import { createPublicClient, type Address, type Hex } from "viem";
import { defaultRpcUrl } from "@terminal/config/default-rpc";
import { useServices } from "../app/services";

/** What Explore reads from a chain. */
export type ChainReader = ReturnType<typeof chainReaderFor>;

/**
 * A reader over one chain's RPC.
 *
 * @param rpcUrl The RPC URL.
 */
export const chainReaderFor = (rpcUrl: string) => {
  const client = createPublicClient({ transport: rpcTransport(rpcUrl) });
  return {
    transaction: async (hash: Hex) => {
      const [tx, receipt] = await Promise.all([client.getTransaction({ hash }), client.getTransactionReceipt({ hash })]);
      return { tx, receipt };
    },
    block: (number: bigint) => client.getBlock({ blockNumber: number }),
    /** The verifier a light client checks proofs with. */
    verifier: (lightClient: Address) => client.readContract({ address: lightClient, abi: beaconLightClientAbi, functionName: "verifier" }) as Promise<Address>,
    account: async (address: Address) => {
      const [balance, nonce, code] = await Promise.all([client.getBalance({ address }), client.getTransactionCount({ address }), client.getCode({ address })]);
      return { balance, nonce, isContract: code !== undefined && code !== "0x" };
    },
  };
};

/** The reader of a chain on this page, or null on the sample page (it reads no chain) or without an RPC. */
export const useChainReader = (): ((chainId: number) => ChainReader | null) => {
  const { configuration, connection } = useServices();
  return (chainId) => {
    if (configuration.dataMode === "fixture") return null;
    const rpc = connection?.resolved().rpcUrls[chainId]?.value ?? configuration.rpcUrls[chainId] ?? defaultRpcUrl(chainId);
    return rpc === null ? null : chainReaderFor(rpc);
  };
};

/** The pages of a chain's block explorers (from the chain metadata) for a transaction, a block or an address. */
export const explorerLinksOf = (chainId: number, kind: "tx" | "block" | "address", id: string): readonly { readonly name: string; readonly url: string }[] => explorerLinks(chainId, kind, id);

/** A page on a chain's main block explorer, or undefined for a chain without one. */
export const explorerUrl = (chainId: number, kind: "tx" | "block" | "address", id: string): string | undefined => explorerLinks(chainId, kind, id)[0]?.url;
