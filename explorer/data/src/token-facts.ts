import { erc20Abi, type Address } from "viem";
import { tokenMediatorAbi } from "./abis/index.js";
import { ZERO_ADDRESS } from "@zkb/core";
import type { TokenRow } from "./api-views.js";
import type { ViewCall } from "./rpc/chain-reader.js";

/** Anything that can call a view function: a Ponder client, a viem client or a {@link ChainReader}. */
export type ContractReader = { readonly readContract: (call: ViewCall) => Promise<unknown> };

/** The name, symbol and decimals of a token, each null when the chain did not answer. */
export type TokenMetadata = {
  readonly name: string | null;
  readonly symbol: string | null;
  readonly decimals: number | null;
};

/** The facts about a token that the caller already knows. */
export type TokenHints = {
  readonly isBridgedCopy: boolean;
  readonly homeChainId: number;
  readonly homeToken: Address;
  readonly registeredTransactionHash?: `0x${string}`;
  readonly registeredBlockNumber?: bigint;
  readonly registeredTimestamp?: bigint;
};

/** Reads one view of a token. A token that reverts, or answers with another type, gives null. */
const tryRead = async <value>(read: () => Promise<value>): Promise<value | null> => {
  try {
    return await read();
  } catch {
    return null;
  }
};

/**
 * Reads the metadata of an ERC-20 token. A name is a hypothesis: a token may revert, return bytes32, or lie, so the
 * caller stores whether the read worked.
 *
 * @param reader Reads views of the chain that holds the token.
 * @param address The token.
 * @param blockNumber The block to read at. Without it the reader answers at its latest block.
 */
export const readTokenMetadata = async (reader: ContractReader, address: Address, blockNumber?: bigint): Promise<TokenMetadata> => {
  const at = blockNumber === undefined ? {} : { blockNumber };
  const [name, symbol, decimals] = await Promise.all([
    tryRead(() => reader.readContract({ abi: erc20Abi, address, functionName: "name", ...at }) as Promise<string>),
    tryRead(() => reader.readContract({ abi: erc20Abi, address, functionName: "symbol", ...at }) as Promise<string>),
    tryRead(() => reader.readContract({ abi: erc20Abi, address, functionName: "decimals", ...at }) as Promise<number>),
  ]);
  return { name, symbol, decimals };
};

/**
 * Asks the mediator whether a token is a bridged copy. A bridged copy has a native token behind it.
 *
 * @param reader Reads views of the chain that holds the token.
 * @param mediator The mediator of that chain.
 * @param token The token.
 * @param blockNumber The block to read at. Without it the reader answers at its latest block.
 * @returns The native token behind a bridged copy, or null when the token is native on this chain.
 */
export const nativeTokenBehind = async (reader: ContractReader, mediator: Address, token: Address, blockNumber?: bigint): Promise<Address | null> => {
  const native = (await reader.readContract({
    abi: tokenMediatorAbi,
    address: mediator,
    functionName: "nativeTokenAddress",
    args: [token],
    ...(blockNumber === undefined ? {} : { blockNumber }),
  })) as string;
  return native.toLowerCase() === ZERO_ADDRESS ? null : (native.toLowerCase() as Address);
};

/** The inputs of {@link buildTokenRow}. */
export type BuildTokenRowInput = {
  readonly chainId: number;
  readonly address: Address;
  readonly metadata: TokenMetadata;
  readonly hints: TokenHints;
};

/**
 * The row of a token. When the chain gave no decimals, the row says 18 and `metadataRead` is false, so a reader can tell
 * a read value from an assumed one.
 *
 * @param input The chain, the token, what was read and what the caller knows.
 */
export const buildTokenRow = (input: BuildTokenRowInput): TokenRow => ({
  chainId: input.chainId,
  address: input.address,
  name: input.metadata.name,
  symbol: input.metadata.symbol,
  decimals: input.metadata.decimals ?? 18,
  metadataRead: input.metadata.decimals !== null,
  isBridgedCopy: input.hints.isBridgedCopy,
  homeChainId: input.hints.homeChainId,
  homeToken: input.hints.homeToken,
  registeredTransactionHash: input.hints.registeredTransactionHash ?? null,
  registeredBlockNumber: input.hints.registeredBlockNumber ?? null,
  registeredTimestamp: input.hints.registeredTimestamp ?? null,
});
