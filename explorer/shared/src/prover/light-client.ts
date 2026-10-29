import type { Address, PublicClient } from "viem";
import { beaconLightClientAbi } from "../abis/index.js";
import type { LightClientReader } from "./proof-intake.js";

/**
 * Reads the stored head, the header root of that head and the program key from a `BeaconLightClient`. The bots, the
 * webhook and the msgboard indexer share this one reader.
 *
 * @param client A client of the destination chain. Only `readContract` is used.
 * @param lightClient The light client address.
 */
export function createLightClientReader(client: Pick<PublicClient, "readContract">, lightClient: Address): LightClientReader {
  return {
    async read() {
      const [headSlot, programKey] = await Promise.all([
        client.readContract({ address: lightClient, abi: beaconLightClientAbi, functionName: "head" }),
        client.readContract({ address: lightClient, abi: beaconLightClientAbi, functionName: "programVKey" }),
      ]);
      const headRoot = await client.readContract({
        address: lightClient,
        abi: beaconLightClientAbi,
        functionName: "headers",
        args: [headSlot],
      });
      return { headSlot: BigInt(headSlot), headRoot, programKey };
    },
  };
}
