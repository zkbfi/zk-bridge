import type { Address } from "viem";
import type { Context } from "ponder:registry";
import { tokens } from "ponder:schema";
import {
  buildTokenRow,
  nativeTokenBehind as readNativeTokenBehind,
  readTokenMetadata as readMetadata,
  sideOf,
  type ContractReader,
  type TokenHints,
  type TokenMetadata,
} from "@zk-bridge/shared";
import { pair } from "./pair";
import type { IndexingDatabase } from "./message-store";

type AnyContext = Context<"TokenMediator:TokensBridged">;
type Client = AnyContext["client"];

export type { TokenHints };

/**
 * Reads the metadata of an ERC-20 token. A name is a hypothesis: a token may revert, return bytes32, or lie, so the
 * caller stores whether the read worked.
 *
 * @param client The Ponder client of the chain.
 * @param address The token.
 */
export const readTokenMetadata = (client: Client, address: Address): Promise<TokenMetadata> =>
  readMetadata(client as unknown as ContractReader, address);

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
  await input.database
    .insert(tokens)
    .values(buildTokenRow({ chainId: input.chainId, address: input.address, metadata, hints: input.hints }));
};

/**
 * Asks the mediator whether a token is a bridged copy. A bridged copy has a native token behind it.
 *
 * @param client The Ponder client of the chain.
 * @param chainId The chain of the token.
 * @param token The token.
 * @returns The native token behind a bridged copy, or null when the token is native here.
 */
export const nativeTokenBehind = (client: Client, chainId: number, token: Address): Promise<Address | null> =>
  readNativeTokenBehind(client as unknown as ContractReader, sideOf(pair, chainId).contracts.mediator, token);
