import { getAddress, type Address, type PublicClient } from "viem";
import { deliveryRouterAbi } from "@zk-bridge/shared";
import { BotConfigError } from "../config/bot-config.ts";

/** Input of {@link readRewardAddress}. */
export interface RewardAddressInput {
  /** A client of the destination chain. */
  readonly client: Pick<PublicClient, "readContract">;
  readonly deliveryRouter: Address;
  /** For the error message. */
  readonly chainName: string;
}

/**
 * Reads the address that receives every tip of the delivery router. The router decides this address: it is the immutable
 * `rewardAddress()` of its constructor. The runner uses it for its accounting and its log only. It checks nothing against it.
 *
 * @returns the reward address, checksummed.
 * @throws BotConfigError that names the router and the chain when the read fails.
 */
export async function readRewardAddress(input: RewardAddressInput): Promise<Address> {
  try {
    return getAddress(await input.client.readContract({ address: input.deliveryRouter, abi: deliveryRouterAbi, functionName: "rewardAddress" }));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new BotConfigError(`Cannot read rewardAddress() of the delivery router ${input.deliveryRouter} on ${input.chainName}: ${reason}`);
  }
}
