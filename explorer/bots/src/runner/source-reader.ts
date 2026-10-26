import { getAbiItem, toEventSelector, type Address, type Hex, type PublicClient } from "viem";
import { messageBridgeAbi } from "@zk-bridge/shared";

/** Finds where a message sits in the receipt of its source transaction. */
export interface SourceReader {
  /**
   * The index, inside the receipt, of the `UserRequestForAffirmation` log of a message. The `evidence` command counts
   * this way, not by the index inside the block.
   *
   * @returns The index, or null when the receipt holds no such log.
   */
  findMessageLogIndex(input: { readonly transactionHash: Hex; readonly messageId: Hex }): Promise<number | null>;
}

const REQUEST_EVENT = getAbiItem({ abi: messageBridgeAbi, name: "UserRequestForAffirmation" });

/** Builds the reader over a client of the source chain and the address of the source bridge. */
export function createSourceReader(client: PublicClient, sourceBridge: Address): SourceReader {
  const topic = toEventSelector(REQUEST_EVENT);
  return {
    async findMessageLogIndex({ transactionHash, messageId }) {
      const receipt = await client.getTransactionReceipt({ hash: transactionHash });
      const index = receipt.logs.findIndex(
        (log) =>
          log.address.toLowerCase() === sourceBridge.toLowerCase() &&
          log.topics[0] === topic &&
          log.topics[1]?.toLowerCase() === messageId.toLowerCase(),
      );
      return index < 0 ? null : index;
    },
  };
}
