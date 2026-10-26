import { getAddress, type Address, type PublicClient } from "viem";
import { deliveryRouterAbi } from "@zk-bridge/shared";
import { BotConfigError } from "../config/bot-config.ts";

/** Input of {@link requireWhitelistedRunner}. */
export interface WhitelistInput {
  /** A client of the destination chain. */
  readonly client: Pick<PublicClient, "readContract">;
  readonly deliveryRouter: Address;
  /** The address that signs the delivery transactions. */
  readonly signerAddress: Address;
  /** For the error message. */
  readonly chainName: string;
}

/**
 * Refuses to run when the delivery router does not whitelist the signer. The router lets exactly one account call
 * `executeMessageWithRunner`: the immutable `runner` of its constructor. Any other caller reverts, so a runner that
 * starts with another signer would pay for a failed simulation of every delivery. The check reads `DeliveryRouter.runner()`
 * and compares it with the signer, so the configured router and the signer must be a pair.
 *
 * @throws BotConfigError when the router names another runner, or the read fails.
 */
export async function requireWhitelistedRunner(input: WhitelistInput): Promise<void> {
  const whitelisted = await readRunner(input);
  if (getAddress(whitelisted) === getAddress(input.signerAddress)) return;
  throw new BotConfigError(
    `The delivery router ${input.deliveryRouter} on ${input.chainName} whitelists ${getAddress(whitelisted)}, but the runner signs with ${getAddress(input.signerAddress)}. ` +
      "Configure the router whose runner is this signer, or the signer that the router names.",
  );
}

async function readRunner(input: WhitelistInput): Promise<Address> {
  try {
    return await input.client.readContract({ address: input.deliveryRouter, abi: deliveryRouterAbi, functionName: "runner" });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new BotConfigError(`Cannot read runner() of the delivery router ${input.deliveryRouter} on ${input.chainName}: ${reason}`);
  }
}

/** Input of {@link requireRewardAddress}. */
export interface RewardAddressInput {
  /** A client of the destination chain. */
  readonly client: Pick<PublicClient, "readContract">;
  readonly deliveryRouter: Address;
  /** The address that the configuration names for the fees, or undefined when it names none. */
  readonly rewardAddress: Address | undefined;
  /** The address that signs the delivery transactions. */
  readonly signerAddress: Address;
  /** For the error message. */
  readonly chainName: string;
}

/**
 * Refuses to run when the reward address of the configuration is not the one the delivery router pays. The router pays
 * every fee to its immutable `rewardAddress()`, and it reverts a call that names another address. A runner with a wrong
 * address would revert every delivery. The check also refuses a reward address equal to the signer: the signer is a hot
 * key that only pays gas, and the fees belong in a separate account that can stay cold.
 *
 * @returns the reward address, checksummed.
 * @throws BotConfigError when the configuration names none, names the signer, or names an address that differs from the router.
 */
export async function requireRewardAddress(input: RewardAddressInput): Promise<Address> {
  if (input.rewardAddress === undefined) {
    throw new BotConfigError(`The runner uses the delivery router ${input.deliveryRouter} on ${input.chainName}, so runner.rewardAddress is required: it is the address that receives the fees.`);
  }
  const configured = getAddress(input.rewardAddress);
  if (configured === getAddress(input.signerAddress)) {
    throw new BotConfigError(
      `runner.rewardAddress ${configured} is the address of the signer. The signer is a hot key. Name a separate account for the fees.`,
    );
  }
  const stored = getAddress(await readRewardAddress(input));
  if (stored === configured) return configured;
  throw new BotConfigError(
    `The delivery router ${input.deliveryRouter} on ${input.chainName} pays the fees to ${stored}, but runner.rewardAddress is ${configured}. ` +
      "Configure the address that the router names, or the router that pays this address.",
  );
}

async function readRewardAddress(input: RewardAddressInput): Promise<Address> {
  try {
    return await input.client.readContract({ address: input.deliveryRouter, abi: deliveryRouterAbi, functionName: "rewardAddress" });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new BotConfigError(`Cannot read rewardAddress() of the delivery router ${input.deliveryRouter} on ${input.chainName}: ${reason}`);
  }
}
