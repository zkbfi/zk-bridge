import { createPublicClient, defineChain, http, type Abi, type AbiEvent, type Address, type Hex } from "viem";

/**
 * What the RPC data source asks of a chain. It is a narrow slice of a viem public client, so a test can answer from a
 * small fake chain and a page can use a viem client over HTTP. A reader never signs and never sends.
 */

/** One decoded event log. Addresses are lowercase. */
export type ChainLog = {
  readonly eventName: string;
  readonly address: Address;
  readonly blockNumber: bigint;
  readonly logIndex: number;
  readonly transactionHash: Hex;
  /** The decoded arguments by name. Addresses are lowercase. */
  readonly args: Readonly<Record<string, unknown>>;
};

/** The part of a block that the source reads. */
export type ChainBlock = {
  readonly number: bigint;
  readonly timestamp: bigint;
  /** The base fee in wei per gas, or null when the chain reports none. */
  readonly baseFeePerGas: bigint | null;
};

/** The part of a transaction receipt that the source reads. */
export type ChainReceipt = {
  readonly from: Address;
  readonly blockNumber: bigint;
  readonly gasUsed: bigint;
  readonly effectiveGasPrice: bigint;
  readonly logs: readonly { readonly address: Address; readonly topics: readonly Hex[] }[];
};

/** Which block to read: one number, or a named tag. */
export type BlockSelector = { readonly blockNumber: bigint } | { readonly tag: "latest" | "finalized" };

/** A window of logs to read: every listed event of one contract between two blocks, both inclusive. */
export type LogRequest = {
  readonly address: Address;
  readonly events: readonly AbiEvent[];
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
};

/** A call of a view function. */
export type ViewCall = {
  readonly address: Address;
  readonly abi: Abi;
  readonly functionName: string;
  readonly args?: readonly unknown[];
  /** The block to read at. Without it the node answers at its own latest block. */
  readonly blockNumber?: bigint;
};

/** Reads one chain. */
export interface ChainReader {
  /** `eth_chainId`. */
  getChainId(): Promise<number>;
  getBlock(selector: BlockSelector): Promise<ChainBlock>;
  getLogs(request: LogRequest): Promise<readonly ChainLog[]>;
  readContract(call: ViewCall): Promise<unknown>;
  getTransactionReceipt(hash: Hex): Promise<ChainReceipt>;
}

/** The methods of a viem public client that the reader uses. A test passes a fake. */
export type ViemClientLike = {
  getChainId(): Promise<number>;
  getBlock(arguments_: { blockNumber: bigint } | { blockTag: "latest" | "finalized" }): Promise<{ number: bigint; timestamp: bigint; baseFeePerGas?: bigint | null }>;
  getLogs(arguments_: { address: Address; events: readonly AbiEvent[]; fromBlock: bigint; toBlock: bigint; strict: true }): Promise<
    readonly { eventName: string; address: Address; blockNumber: bigint; logIndex: number; transactionHash: Hex; args: unknown }[]
  >;
  readContract(arguments_: ViewCall): Promise<unknown>;
  getTransactionReceipt(arguments_: { hash: Hex }): Promise<{
    from: Address;
    blockNumber: bigint;
    gasUsed: bigint;
    effectiveGasPrice: bigint;
    logs: readonly { address: Address; topics: readonly Hex[] }[];
  }>;
};

/**
 * Lowercases every address-like string in decoded arguments, because the indexer stores addresses in lowercase and the
 * views must give the same text.
 *
 * @param args The decoded arguments of a log.
 */
const lowercaseArguments = (args: unknown): Readonly<Record<string, unknown>> =>
  Object.fromEntries(
    Object.entries((args ?? {}) as Record<string, unknown>).map(([name, value]) => [
      name,
      typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value) ? value.toLowerCase() : value,
    ]),
  );

/**
 * Wraps a viem public client as a {@link ChainReader}.
 *
 * @param client The viem client, or a fake with the same methods.
 */
export const createViemChainReader = (client: ViemClientLike): ChainReader => ({
  getChainId: () => client.getChainId(),
  async getBlock(selector) {
    const block = await client.getBlock("tag" in selector ? { blockTag: selector.tag } : { blockNumber: selector.blockNumber });
    return { number: block.number, timestamp: block.timestamp, baseFeePerGas: block.baseFeePerGas ?? null };
  },
  async getLogs(request) {
    const logs = await client.getLogs({ ...request, strict: true });
    return logs.map((log) => ({
      eventName: log.eventName,
      address: log.address.toLowerCase() as Address,
      blockNumber: log.blockNumber,
      logIndex: log.logIndex,
      transactionHash: log.transactionHash,
      args: lowercaseArguments(log.args),
    }));
  },
  readContract: (call) => client.readContract(call),
  async getTransactionReceipt(hash) {
    const receipt = await client.getTransactionReceipt({ hash });
    return {
      from: receipt.from.toLowerCase() as Address,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed,
      effectiveGasPrice: receipt.effectiveGasPrice,
      logs: receipt.logs.map((log) => ({ address: log.address.toLowerCase() as Address, topics: log.topics })),
    };
  },
});

/** The input of {@link createHttpChainReader}. */
export type HttpChainReaderInput = {
  readonly chainId: number;
  readonly name: string;
  /** The RPC URL. It can hold a key. */
  readonly url: string;
};

/**
 * A reader over JSON-RPC on HTTP, with a viem client. It opens no connection until the first call.
 *
 * @param input The chain and its RPC URL.
 */
export const createHttpChainReader = (input: HttpChainReaderInput): ChainReader => {
  const client = createPublicClient({
    chain: defineChain({
      id: input.chainId,
      name: input.name,
      nativeCurrency: { name: "coin", symbol: "coin", decimals: 18 },
      rpcUrls: { default: { http: [input.url] } },
    }),
    transport: http(input.url, { timeout: 15_000, retryCount: 1 }),
  });
  return createViemChainReader(client as unknown as ViemClientLike);
};
