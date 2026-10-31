import { zeroHash, type Address, type PublicClient } from "viem";
import { beaconLightClientAbi } from "../abis/index.js";
import type { LightClientHead, LightClientReader } from "./proof-intake.js";

/**
 * Reads the stored head, the header root of that head and the program key from a `BeaconLightClient`. The bots, the
 * webhook and the msgboard indexer share this one reader.
 *
 * The three reads name one block. Behind a load balancer, reads without a block can reach nodes at different heights,
 * and a head from one node with a root from another looks like a moved head, which makes the indexer drop a good
 * proof. A node that does not have the block yet fails the read instead. The contract stores a root for its head, so
 * an empty root also fails the read.
 *
 * @param client A client of the destination chain. Only `getBlockNumber` and `readContract` are used.
 * @param lightClient The light client address.
 */
export function createLightClientReader(client: Pick<PublicClient, "getBlockNumber" | "readContract">, lightClient: Address): LightClientReader {
  // The clock settings are immutable in the contract, so one read serves for good. A failed read is not kept. The read
  // names the block of the first state read, like every other read.
  let clock: Promise<NonNullable<LightClientHead["clock"]>> | null = null;
  const readClock = (blockNumber: bigint): Promise<NonNullable<LightClientHead["clock"]>> => {
    clock ??= Promise.all([
      client.readContract({ address: lightClient, abi: beaconLightClientAbi, functionName: "genesisTime", blockNumber }),
      client.readContract({ address: lightClient, abi: beaconLightClientAbi, functionName: "secondsPerSlot", blockNumber }),
    ]).then(([genesisTime, secondsPerSlot]) => ({ genesisTime: BigInt(genesisTime), secondsPerSlot: BigInt(secondsPerSlot) }));
    clock.catch(() => (clock = null));
    return clock;
  };
  return {
    async read() {
      const blockNumber = await client.getBlockNumber();
      const settings = await readClock(blockNumber);
      const [headSlot, programKey] = await Promise.all([
        client.readContract({ address: lightClient, abi: beaconLightClientAbi, functionName: "head", blockNumber }),
        client.readContract({ address: lightClient, abi: beaconLightClientAbi, functionName: "programVKey", blockNumber }),
      ]);
      const headRoot = await client.readContract({
        address: lightClient,
        abi: beaconLightClientAbi,
        functionName: "headers",
        args: [headSlot],
        blockNumber,
      });
      if (headRoot === zeroHash) throw new Error(`The light client has no header root for its head slot ${headSlot} at block ${blockNumber}.`);
      return { headSlot: BigInt(headSlot), headRoot, programKey, clock: settings };
    },
  };
}
