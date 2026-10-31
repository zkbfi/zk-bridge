import { beaconLightClientAbi } from "@zk-bridge/shared";
import type { Address, Hex } from "viem";

/** The part of the Ponder client that reads a contract at a named block. */
export type ContractReader = {
  readonly readContract: (call: {
    abi: typeof beaconLightClientAbi;
    address: Address;
    functionName: "head" | "headers" | "genesisTime" | "secondsPerSlot";
    args?: readonly [bigint];
    blockNumber: bigint;
  }) => Promise<unknown>;
};

/** The head of a light client before any update: the checkpoint of its deployment, with the slot clock. */
export type InitialHead = {
  readonly slot: bigint;
  readonly headerRoot: Hex;
  readonly blockNumber: bigint;
  readonly genesisTime: bigint;
  readonly secondsPerSlot: bigint;
};

/**
 * Reads the head that a light client holds at a named block, with its header root and the slot clock of the tracked
 * beacon chain. Reading at a named block keeps the result the same on every reindex.
 *
 * @param client Reads the chain that holds the light client.
 * @param address The light client.
 * @param blockNumber The block to read at.
 * @returns The head, or null when the contract has no code there yet, the read fails, or the head is slot zero.
 */
export const readInitialHead = async (client: ContractReader, address: Address, blockNumber: bigint): Promise<InitialHead | null> => {
  const read = (functionName: "head" | "genesisTime" | "secondsPerSlot") =>
    client.readContract({ abi: beaconLightClientAbi, address, functionName, blockNumber });
  try {
    const slot = await read("head");
    if (typeof slot !== "bigint" || slot === 0n) return null;
    const [headerRoot, genesisTime, secondsPerSlot] = await Promise.all([
      client.readContract({ abi: beaconLightClientAbi, address, functionName: "headers", args: [slot], blockNumber }),
      read("genesisTime"),
      read("secondsPerSlot"),
    ]);
    return { slot, headerRoot: headerRoot as Hex, blockNumber, genesisTime: genesisTime as bigint, secondsPerSlot: secondsPerSlot as bigint };
  } catch {
    // No code at this block (the light client is deployed later) or the node failed: the next tip tries again.
    return null;
  }
};

/** The columns of `light_client_heads` that an initial head fills. */
export const initialHeadColumns = (initial: InitialHead | null) => ({
  initialSlot: initial?.slot ?? null,
  initialHeadBlockNumber: initial?.blockNumber ?? null,
  genesisTime: initial?.genesisTime ?? null,
  secondsPerSlot: initial?.secondsPerSlot ?? null,
});
