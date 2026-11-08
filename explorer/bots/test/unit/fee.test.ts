import { describe, expect, it } from "vitest";
import { decideDelivery, feeGasUnitsOf, payoutOfOffer, readFeeOffer, valueFeeInWei } from "../../src/runner/fee.ts";
import { DELIVERY_ROUTER, OTHER_TOKEN, WRAPPED_NATIVE, address, feeOfferData } from "../support/builders.ts";
import { encodeFunctionData } from "viem";
import { tokenMediatorAbi } from "@zk-bridge/shared";

const director = { recipient: address(0x12), settings: 8n, limit: 0n, multiplier: 10n ** 16n, callGas: 0n };

describe("reading the fee offer", () => {
  it("reads the FeeDirector from the callback data of a message to the delivery router", () => {
    const offer = readFeeOffer({ messageData: feeOfferData({ director, value: 5000n }), deliveryRouter: DELIVERY_ROUTER });
    expect(offer).toEqual({ kind: "offer", director, value: 5000n, call: null });
  });

  it("compares the router address without regard to letter case", () => {
    const offer = readFeeOffer({ messageData: feeOfferData({ director, value: 1n }), deliveryRouter: DELIVERY_ROUTER.toUpperCase().replace("0X", "0x") as `0x${string}` });
    expect(offer.kind).toBe("offer");
  });

  it("finds no offer for each way a message can lack one", () => {
    const reason = (messageData: `0x${string}`, deliveryRouter: typeof DELIVERY_ROUTER | null = DELIVERY_ROUTER) => {
      const offer = readFeeOffer({ messageData, deliveryRouter });
      return offer.kind === "none" ? offer.reason : "offer";
    };
    expect(reason(feeOfferData({ director, value: 1n }), null)).toBe("no-delivery-router-configured");
    expect(reason("0xdeadbeef")).toBe("not-a-token-message");
    expect(reason(feeOfferData({ director, value: 1n, recipient: address(0x13) }))).toBe("recipient-is-not-the-delivery-router");
    const plain = encodeFunctionData({ abi: tokenMediatorAbi, functionName: "handleBridgedTokens", args: [OTHER_TOKEN, DELIVERY_ROUTER, 1n] });
    expect(reason(plain)).toBe("no-callback-data");
    const legacy = encodeFunctionData({ abi: tokenMediatorAbi, functionName: "handleBridgedTokensAndCall", args: [OTHER_TOKEN, DELIVERY_ROUTER, 1n, address(0x14), 400_000n] });
    expect(reason(legacy)).toBe("legacy-native-receiver");
    const short = encodeFunctionData({ abi: tokenMediatorAbi, functionName: "handleBridgedTokensAndCall", args: [OTHER_TOKEN, DELIVERY_ROUTER, 1n, "0x1234", 400_000n] });
    expect(reason(short)).toBe("unknown-callback-data");
    const empty = encodeFunctionData({ abi: tokenMediatorAbi, functionName: "handleBridgedTokensAndCall", args: [OTHER_TOKEN, DELIVERY_ROUTER, 1n, "0x", 400_000n] });
    expect(reason(empty)).toBe("unknown-callback-data");
  });
});

describe("valuing the fee in wei", () => {
  const base = { director, wrappedNative: WRAPPED_NATIVE, valuationsWei: {} };

  it("counts the wrapped native token one for one", () => {
    expect(valueFeeInWei({ ...base, fee: 123n, token: WRAPPED_NATIVE, decimals: 18 })).toEqual({ ok: true, wei: 123n });
  });

  it("scales another token by its configured value and its decimals", () => {
    const valued = valueFeeInWei({ ...base, fee: 2_500_000n, token: OTHER_TOKEN, decimals: 6, valuationsWei: { [OTHER_TOKEN.toLowerCase()]: 4_000_000_000_000_000n } });
    expect(valued).toEqual({ ok: true, wei: 10_000_000_000_000_000n });
  });

  it("prices an unwrap request on another token as a token payout, so it needs a valuation", () => {
    const unwrap = { ...director, settings: 2n };
    expect(payoutOfOffer({ director: unwrap, token: OTHER_TOKEN, wrappedNative: WRAPPED_NATIVE })).toBe("token");
    expect(valueFeeInWei({ ...base, director: unwrap, fee: 500n, token: OTHER_TOKEN, decimals: 18 })).toEqual({ ok: false, reason: "no-price-for-fee-token" });
    const valued = valueFeeInWei({ ...base, director: unwrap, fee: 500n, token: OTHER_TOKEN, decimals: 18, valuationsWei: { [OTHER_TOKEN.toLowerCase()]: 2n * 10n ** 18n } });
    expect(valued).toEqual({ ok: true, wei: 1_000n });
  });

  it("pays the native coin only for an unwrap request on the wrapped native token", () => {
    const unwrap = { ...director, settings: 2n };
    expect(payoutOfOffer({ director: unwrap, token: WRAPPED_NATIVE.toUpperCase().replace("0X", "0x") as `0x${string}`, wrappedNative: WRAPPED_NATIVE })).toBe("native");
    expect(payoutOfOffer({ director, token: WRAPPED_NATIVE, wrappedNative: WRAPPED_NATIVE })).toBe("token");
  });

  it("will not guess the price of a token it does not know", () => {
    expect(valueFeeInWei({ ...base, fee: 1n, token: OTHER_TOKEN, decimals: 18 })).toEqual({ ok: false, reason: "no-price-for-fee-token" });
  });
});

describe("the delivery decision", () => {
  const cost = 1_000n;
  const decide = (feeWei: bigint, maximumLossPercent = 20) => decideDelivery({ feeWei, costWei: cost, maximumLossPercent });

  it("delivers a fee of 801 wei against a cost of 1,000 wei, and leaves out a fee of exactly 800 wei (a loss of 20 percent)", () => {
    expect(decide(801n)).toEqual({ deliver: true, costWei: 1_000n, lossWei: 199n });
    expect(decide(800n)).toEqual({ deliver: false, costWei: 1_000n, lossWei: 200n });
  });

  it("leaves out a delivery with no tip at all", () => {
    expect(decide(0n)).toEqual({ deliver: false, costWei: 1_000n, lossWei: 1_000n });
  });

  it("delivers a tip above the cost, and reports a negative loss", () => {
    expect(decide(1_200n)).toEqual({ deliver: true, costWei: 1_000n, lossWei: -200n });
  });

  it("asks for a tip that covers the cost when the allowed loss is 0 percent: break-even delivers, one wei below does not", () => {
    expect(decide(1_001n, 0).deliver).toBe(true);
    expect(decide(1_000n, 0)).toEqual({ deliver: true, costWei: 1_000n, lossWei: 0n });
    expect(decide(999n, 0).deliver).toBe(false);
  });

  it("treats a tip of nothing on a cost above zero as a full loss, whatever the limit below 100 percent", () => {
    expect(decide(0n, 99).deliver).toBe(false);
  });

  it("delivers anything when the allowed loss is 100 percent, except a tip of nothing", () => {
    expect(decide(1n, 100).deliver).toBe(true);
    expect(decide(0n, 100).deliver).toBe(false);
  });
});

describe("the call gas in the fee estimate", () => {
  const call = { target: address(0x21), data: "0xabcdef01" } as const;

  it("reads the call of the offer, and null when the data carries none", () => {
    const withCall = readFeeOffer({ messageData: feeOfferData({ director: { ...director, callGas: 50_000n }, value: 1n, call }), deliveryRouter: DELIVERY_ROUTER });
    expect(withCall).toMatchObject({ kind: "offer", call });
    const without = readFeeOffer({ messageData: feeOfferData({ director, value: 1n }), deliveryRouter: DELIVERY_ROUTER });
    expect(without).toMatchObject({ kind: "offer", call: null });
  });

  it("counts only the execution when the offer has no call", () => {
    expect(feeGasUnitsOf({ call: null, executionGas: 300_000n, callGas: 50_000n })).toBe(300_000n);
  });

  it("adds the callGas of the director when the offer has a call, because the call gets exactly that gas", () => {
    expect(feeGasUnitsOf({ call, executionGas: 300_000n, callGas: 50_000n })).toBe(350_000n);
  });
});
