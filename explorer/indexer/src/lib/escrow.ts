import { escrow } from "ponder:schema";
import { tokenMediatorAbi, sideOf } from "@zk-bridge/shared";
import type { Address } from "viem";
import type { Context } from "ponder:registry";
import { pair } from "./pair";
import { nativeTokenBehind } from "./tokens";
import type { IndexingDatabase } from "./message-store";

type Client = Context<"TokenMediator:TokensBridged">["client"];

/** The inputs of `refreshEscrow`. */
export type RefreshEscrowInput = {
  readonly database: IndexingDatabase;
  readonly client: Client;
  readonly chainId: number;
  readonly token: Address;
  readonly blockNumber: bigint;
  readonly timestamp: bigint;
};

/**
 * Reads the mediator balance of a native token from the contract, at the block of the event,
 * and stores them. The contract is the authority: the record covers locks, releases, claims and refused transfers.
 * A bridged copy has no escrow, so a call for one does nothing.
 *
 * @param input The database, the client and the token.
 */
export const refreshEscrow = async (input: RefreshEscrowInput): Promise<void> => {
  const isBridgedCopy = (await nativeTokenBehind(input.client, input.chainId, input.token)) !== null;
  if (isBridgedCopy) return;
  const mediator = sideOf(pair, input.chainId).contracts.mediator;
  const balance = await input.client.readContract({ abi: tokenMediatorAbi, address: mediator, args: [input.token], functionName: "mediatorBalance" });
  const row = {
    chainId: input.chainId,
    token: input.token,
    balance,
    updatedBlockNumber: input.blockNumber,
    updatedTimestamp: input.timestamp,
  };
  await input.database.insert(escrow).values(row).onConflictDoUpdate(row);
};
