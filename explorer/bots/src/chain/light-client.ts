import type { Address, Hex, PublicClient } from "viem";
import { beaconLightClientAbi } from "@zk-bridge/shared";

/** What a bot needs to know about a light client. */
export interface LightClientState {
  readonly headSlot: bigint;
  readonly headRoot: Hex;
  readonly programKey: Hex;
}

/** Reads the light client on the destination chain. */
export interface LightClientReader {
  read(): Promise<LightClientState>;
}

/**
 * Reads the stored head, the header root of that head and the program key from a `BeaconLightClient`.
 *
 * @param client A client of the destination chain.
 * @param lightClient The light client address.
 */
export function createLightClientReader(client: PublicClient, lightClient: Address): LightClientReader {
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
