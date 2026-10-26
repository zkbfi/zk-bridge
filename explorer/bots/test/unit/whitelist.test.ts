import { describe, expect, it } from "vitest";
import { BotConfigError } from "../../src/config/bot-config.ts";
import { requireRewardAddress, requireWhitelistedRunner } from "../../src/runner/whitelist.ts";
import { FEE_ROUTER, address } from "../support/builders.ts";

const SIGNER = address(0x31);
const OTHER = address(0x32);

const clientWith = (answer: () => Promise<`0x${string}`>) => ({
  readContract: (async (request: { address: string; functionName: string }) => {
    expect(request.address).toBe(FEE_ROUTER);
    expect(request.functionName).toBe("runner");
    return answer();
  }) as never,
});

const check = (answer: () => Promise<`0x${string}`>, signerAddress = SIGNER) =>
  requireWhitelistedRunner({ client: clientWith(answer), feeRouter: FEE_ROUTER, signerAddress, chainName: "PulseChain" });

describe("the whitelisted runner of the fee router", () => {
  it("starts when FeeRouter.runner() is the address of the signer", async () => {
    await expect(check(async () => SIGNER)).resolves.toBeUndefined();
  });

  it("compares the two addresses without regard to letter case", async () => {
    await expect(check(async () => SIGNER.toLowerCase() as `0x${string}`, SIGNER.toUpperCase().replace("0X", "0x") as `0x${string}`)).resolves.toBeUndefined();
  });

  it("refuses when the router whitelists another account, and names both", async () => {
    const failure = await check(async () => OTHER).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(BotConfigError);
    expect((failure as Error).message).toContain("whitelists");
    expect((failure as Error).message).toContain("PulseChain");
    expect((failure as Error).message.toLowerCase()).toContain(OTHER.toLowerCase());
    expect((failure as Error).message.toLowerCase()).toContain(SIGNER.toLowerCase());
  });

  it("refuses when the router cannot be read, so a wrong address is not taken for a router", async () => {
    await expect(check(async () => { throw new Error("execution reverted"); })).rejects.toThrow(/Cannot read runner\(\)/);
  });
});

describe("the reward address of the fee router", () => {
  const REWARD = address(0x41);
  const OTHER_REWARD = address(0x42);

  const rewardClient = (answer: () => Promise<`0x${string}`>) => ({
    readContract: (async (request: { address: string; functionName: string }) => {
      expect(request.address).toBe(FEE_ROUTER);
      expect(request.functionName).toBe("rewardAddress");
      return answer();
    }) as never,
  });

  const checkReward = (input: { stored?: () => Promise<`0x${string}`>; configured?: `0x${string}` | undefined; signer?: `0x${string}` }) =>
    requireRewardAddress({
      client: rewardClient(input.stored ?? (async () => REWARD)),
      feeRouter: FEE_ROUTER,
      rewardAddress: "configured" in input ? input.configured : REWARD,
      signerAddress: input.signer ?? SIGNER,
      chainName: "PulseChain",
    });

  it("starts when the router pays the configured address, without regard to letter case", async () => {
    await expect(checkReward({})).resolves.toBe(REWARD);
    await expect(checkReward({ stored: async () => REWARD.toUpperCase().replace("0X", "0x") as `0x${string}` })).resolves.toBe(REWARD);
  });

  it("refuses when the router pays another address, and names both, because every call would revert with WrongRewardAddress", async () => {
    const failure = await checkReward({ stored: async () => OTHER_REWARD }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(BotConfigError);
    const message = (failure as Error).message.toLowerCase();
    expect(message).toContain(REWARD.toLowerCase());
    expect(message).toContain(OTHER_REWARD.toLowerCase());
    expect(message).toContain("pulsechain");
  });

  it("refuses a reward address that is the signer, because the signer is a hot key", async () => {
    const failure = await checkReward({ configured: SIGNER, stored: async () => SIGNER }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(BotConfigError);
    expect((failure as Error).message).toContain("signer");
  });

  it("refuses when the configuration names no reward address, and does not read the chain first", async () => {
    let reads = 0;
    const failure = await checkReward({ configured: undefined, stored: async () => (reads += 1, REWARD) }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(BotConfigError);
    expect((failure as Error).message).toContain("runner.rewardAddress is required");
    expect(reads).toBe(0);
  });

  it("refuses when the router cannot be read", async () => {
    await expect(checkReward({ stored: async () => { throw new Error("execution reverted"); } })).rejects.toThrow(/Cannot read rewardAddress\(\)/);
  });
});
