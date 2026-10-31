import type { BlockSelector, ChainBlock, ChainReader } from "./chain-reader.js";

/** An answer and the block it was read at. The caller passes the block on to the rule that uses the answer. */
export type AtBlock<value> = { readonly value: value; readonly block: ChainBlock };

/**
 * A reader whose contract reads name one block. A call that names its own block keeps it. The other methods pass
 * through. Behind a load balancer, reads without a block can reach nodes at different heights; reads that name one
 * block cannot.
 *
 * @param reader The reader to wrap.
 * @param blockNumber The block that the contract reads name.
 */
export const pinReader = (reader: ChainReader, blockNumber: bigint): ChainReader => ({
  getChainId: () => reader.getChainId(),
  getBlock: (selector) => reader.getBlock(selector),
  getLogs: (request) => reader.getLogs(request),
  readContract: (call) => reader.readContract({ ...call, blockNumber: call.blockNumber ?? blockNumber }),
  getTransactionReceipt: (hash) => reader.getTransactionReceipt(hash),
});

/**
 * Resolves a block once, runs `read` with a reader pinned to it, and returns the answer with the block.
 *
 * @param reader Reads the chain.
 * @param selector The block: a number, or a tag that is read once and then fixed to its number.
 * @param read The reads. Every contract read it makes through the pinned reader names the block.
 */
export const readAt = async <value>(
  reader: ChainReader,
  selector: BlockSelector,
  read: (pinned: ChainReader, block: ChainBlock) => Promise<value>,
): Promise<AtBlock<value>> => {
  const block = await reader.getBlock(selector);
  return { value: await read(pinReader(reader, block.number), block), block };
};
