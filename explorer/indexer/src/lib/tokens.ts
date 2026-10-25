import { erc20Abi, type Address } from "viem";
import type { Context } from "ponder:registry";
import { tokens } from "ponder:schema";
import { tokenMediatorAbi, ZERO_ADDRESS, sideOf } from "@zk-bridge/shared";
import { pair } from "./pair";
import type { IndexingDatabase } from "./message-store";

type AnyContext = Context<"TokenMediator:TokensBridged">;
type Client = AnyContext["client"];

/** The facts about a token that the caller already knows. */
export type TokenHints = {
  readonly isBridgedCopy: boolean;
  readonly homeChainId: number;
  readonly homeToken: Address;
  readonly registeredTransactionHash?: `0x${string}`;
  readonly registeredBlockNumber?: bigint;
  readonly registeredTimestamp?: bigint;
};

/** The name, symbol and decimals of a token, each null when the chain did not answer. */
type TokenMetadata = {
  readonly name: string | null;
  readonly symbol: string | null;
  readonly decimals: number | null;
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
 * @param client The Ponder client of the chain.
 * @param address The token.
 */
export const readTokenMetadata = async (client: Client, address: Address): Promise<TokenMetadata> => {
  const [name, symbol, decimals] = await Promise.all([
    tryRead(() => client.readContract({ abi: erc20Abi, address, functionName: "name" })),
    tryRead(() => client.readContract({ abi: erc20Abi, address, functionName: "symbol" })),
    tryRead(() => client.readContract({ abi: erc20Abi, address, functionName: "decimals" })),
  ]);
  return { name, symbol, decimals };
};

/** The inputs of `ensureToken`. */
export type EnsureTokenInput = {
  readonly database: IndexingDatabase;
  readonly client: Client;
  readonly chainId: number;
  readonly address: Address;
  readonly hints: TokenHints;
};

/**
 * Makes sure the token has a row, reading its metadata from the chain on first sight.
 * A token that is already stored is left alone, except that registration facts fill in when they arrive later.
 *
 * @param input The database, the client, the token and what the caller knows.
 */
export const ensureToken = async (input: EnsureTokenInput): Promise<void> => {
  const existing = await input.database.find(tokens, { chainId: input.chainId, address: input.address });
  if (existing) return;
  const metadata = await readTokenMetadata(input.client, input.address);
  const metadataRead = metadata.decimals !== null;
  await input.database.insert(tokens).values({
    chainId: input.chainId,
    address: input.address,
    name: metadata.name,
    symbol: metadata.symbol,
    decimals: metadata.decimals ?? 18,
    metadataRead,
    isBridgedCopy: input.hints.isBridgedCopy,
    homeChainId: input.hints.homeChainId,
    homeToken: input.hints.homeToken,
    registeredTransactionHash: input.hints.registeredTransactionHash ?? null,
    registeredBlockNumber: input.hints.registeredBlockNumber ?? null,
    registeredTimestamp: input.hints.registeredTimestamp ?? null,
  });
};

/**
 * Asks the mediator whether a token is a bridged copy. A bridged copy has a native token behind it.
 *
 * @param client The Ponder client of the chain.
 * @param chainId The chain of the token.
 * @param token The token.
 * @returns The native token behind a bridged copy, or null when the token is native here.
 */
export const nativeTokenBehind = async (client: Client, chainId: number, token: Address): Promise<Address | null> => {
  const native = await client.readContract({
    abi: tokenMediatorAbi,
    address: sideOf(pair, chainId).contracts.mediator,
    functionName: "nativeTokenAddress",
    args: [token],
  });
  return native.toLowerCase() === ZERO_ADDRESS ? null : (native.toLowerCase() as Address);
};
