import { transactionCosts } from "ponder:schema";
import { createPublicClient, http, type Hex } from "viem";
import { nativeUsd, nearestBlockAt, poolReaderOver, transactionCostRow, type BlockClock, type ContractCaller, type NativePriceSource, type PriceQuote, type TransactionCostRow } from "@zk-bridge/shared";
import { pair } from "./pair";

/** What pricing an Ethereum transaction needs: PulseChain reads and blocks, from the pair's PulseChain RPC. */
export type PulsechainAccess = { readonly caller: ContractCaller; readonly clock: BlockClock; readonly firstBlock: bigint };

let access: PulsechainAccess | null | undefined;

/**
 * Sets the PulseChain access instead of the pair's RPC (a caller with its own client; the unit tests set none).
 *
 * @param value The access, or null for none.
 */
export const setPulsechainAccess = (value: PulsechainAccess | null): void => {
  access = value;
};

/**
 * The PulseChain access of the pair (made once), or null when the pair has no PulseChain side.
 */
export const pulsechainAccess = (): PulsechainAccess | null => {
  if (access !== undefined) return access;
  const side = pair.sides.find((candidate) => candidate.chainId === 369);
  if (side === undefined) return (access = null);
  const client = createPublicClient({ transport: http(side.rpcUrl) });
  access = {
    caller: client as unknown as ContractCaller,
    clock: {
      latest: async () => {
        const block = await client.getBlock();
        return { number: block.number, timestamp: block.timestamp };
      },
      timestampOf: async (blockNumber) => (await client.getBlock({ blockNumber })).timestamp,
    },
    firstBlock: BigInt(side.startBlock),
  };
  return access;
};

/**
 * The native coin's dollar price for a transaction, at a named PulseChain block: PLS at the transaction's own block
 * (through the chain's client); ETH at the PulseChain block nearest its timestamp. Null on testnets, without PulseChain
 * access, or when a read fails (the cost is then stored in wei only).
 */
export const nativePriceAt = async (
  input: { readonly chainId: number; readonly blockNumber: bigint; readonly timestamp: bigint; readonly chainCaller: ContractCaller },
  pulsechain: PulsechainAccess | null,
): Promise<(PriceQuote & { readonly source: NativePriceSource }) | null> => {
  try {
    if (input.chainId === 369) return await nativeUsd(poolReaderOver(input.chainCaller, input.blockNumber), 369);
    if (input.chainId !== 1 || pulsechain === null) return null;
    const block = await nearestBlockAt(input.timestamp, pulsechain.clock, pulsechain.firstBlock);
    return await nativeUsd(poolReaderOver(pulsechain.caller, block), 1);
  } catch {
    return null;
  }
};

/** The parts of a Ponder context and event that a cost reads. */
type CostContext = { readonly chain: { readonly id: number }; readonly db: { insert: (table: typeof transactionCosts) => { values: (row: TransactionCostRow) => { onConflictDoNothing: () => Promise<unknown> } } };
  /** Ponder's client, which reads at the event's block (its types leave out `blockNumber`, which it sets itself). */
  readonly client: unknown;
};
type CostEvent = {
  readonly block: { readonly number: bigint; readonly timestamp: bigint };
  readonly transaction: { readonly hash: Hex };
  readonly transactionReceipt: { readonly gasUsed: bigint; readonly effectiveGasPrice: bigint };
};

/**
 * Stores what a bridge transaction cost, once per transaction (several events can share one).
 *
 * @param context The handler's context.
 * @param event The event, with its receipt.
 * @param pulsechain PulseChain access for Ethereum prices.
 */
export const recordTransactionCost = async (context: CostContext, event: CostEvent, pulsechain: PulsechainAccess | null = pulsechainAccess()): Promise<void> => {
  const price = await nativePriceAt({ chainId: context.chain.id, blockNumber: event.block.number, timestamp: event.block.timestamp, chainCaller: context.client as ContractCaller }, pulsechain);
  const row = transactionCostRow({
    chainId: context.chain.id,
    transactionHash: event.transaction.hash,
    blockNumber: event.block.number,
    timestamp: event.block.timestamp,
    gasUsed: event.transactionReceipt.gasUsed,
    effectiveGasPrice: event.transactionReceipt.effectiveGasPrice,
    price,
  });
  await context.db.insert(transactionCosts).values(row).onConflictDoNothing();
};
