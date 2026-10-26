import { describe, expect, it } from "vitest";
import { getAddress } from "viem";
import { BotConfigError } from "../../src/config/bot-config.ts";
import { readRewardAddress } from "../../src/runner/router-reader.ts";
import { DELIVERY_ROUTER, address } from "../support/builders.ts";

const REWARD = address(0x41);

const clientWith = (answer: () => Promise<`0x${string}`>) => ({
  readContract: (async (request: { address: string; functionName: string }) => {
    expect(request.address).toBe(DELIVERY_ROUTER);
    expect(request.functionName).toBe("rewardAddress");
    return answer();
  }) as never,
});

const read = (answer: () => Promise<`0x${string}`>) => readRewardAddress({ client: clientWith(answer), deliveryRouter: DELIVERY_ROUTER, chainName: "PulseChain" });

describe("the reward address of the delivery router", () => {
  it("is the address that the router names, checksummed, whatever its letter case", async () => {
    await expect(read(async () => REWARD)).resolves.toBe(getAddress(REWARD));
    await expect(read(async () => REWARD.toUpperCase().replace("0X", "0x") as `0x${string}`)).resolves.toBe(getAddress(REWARD));
  });

  it("is the answer of the router and nothing else: the reader compares it with no signer and no configuration", async () => {
    const signerAsReward = address(0x31);
    await expect(read(async () => signerAsReward)).resolves.toBe(getAddress(signerAsReward));
  });

  it("stops the start with a configuration error that names the router and the chain when the read fails", async () => {
    const failure = await read(async () => {
      throw new Error("execution reverted");
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(BotConfigError);
    expect((failure as Error).message).toBe(`Cannot read rewardAddress() of the delivery router ${DELIVERY_ROUTER} on PulseChain: execution reverted`);
  });

  it("reports a thrown value that is not an error", async () => {
    await expect(
      read(async () => {
        throw "connection closed";
      }),
    ).rejects.toThrow(`Cannot read rewardAddress() of the delivery router ${DELIVERY_ROUTER} on PulseChain: connection closed`);
  });
});
