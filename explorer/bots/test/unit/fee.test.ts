import { describe, expect, it } from "vitest";
import { feeGasUnitsOf, payoutOfOffer, readFeeOffer } from "../../src/runner/fee.ts";
import { DELIVERY_ROUTER, OTHER_TOKEN, WRAPPED_NATIVE, address, feeOfferData } from "../support/builders.ts";
import { encodeFunctionData } from "viem";
import { feeValueOf, meetsProfitRule, tokenMediatorAbi } from "@zk-bridge/shared";

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

describe("valuing the fee in wei (the shared feeValueOf)", () => {
  const known = { kind: "known" } as const;

  it("counts the wrapped native token one for one: 1e18 wei a whole token of 18 decimals", () => {
    expect(feeValueOf(123n, 18, { state: known, perWholeToken: 10n ** 18n })).toBe(123n);
  });

  it("scales another token by its price in wei and its decimals", () => {
    expect(feeValueOf(2_500_000n, 6, { state: known, perWholeToken: 4_000_000_000_000_000n })).toBe(10_000_000_000_000_000n);
  });

  it("prices an unwrap request on another token as a token payout", () => {
    const unwrap = { ...director, settings: 2n };
    expect(payoutOfOffer({ director: unwrap, token: OTHER_TOKEN, wrappedNative: WRAPPED_NATIVE })).toBe("token");
  });

  it("pays the native coin only for an unwrap request on the wrapped native token", () => {
    const unwrap = { ...director, settings: 2n };
    expect(payoutOfOffer({ director: unwrap, token: WRAPPED_NATIVE.toUpperCase().replace("0X", "0x") as `0x${string}`, wrappedNative: WRAPPED_NATIVE })).toBe("native");
    expect(payoutOfOffer({ director, token: WRAPPED_NATIVE, wrappedNative: WRAPPED_NATIVE })).toBe("token");
  });

  it("will not guess the value of a token with no market price", () => {
    expect(feeValueOf(1n, 18, { state: { kind: "no-market" }, perWholeToken: null })).toBeNull();
  });
});

describe("the delivery decision (the loss rule of the shared tip verdict)", () => {
  const cost = 1_000n;
  const decide = (feeWei: bigint, maximumLossPercent = 20) => meetsProfitRule(feeWei, cost, { kind: "loss", maximumLossPercent });

  it("delivers a fee of 801 wei against a cost of 1,000 wei, and leaves out a fee of exactly 800 wei (a loss of 20 percent)", () => {
    expect(decide(801n)).toBe(true);
    expect(decide(800n)).toBe(false);
  });

  it("leaves out a delivery with no tip at all", () => {
    expect(decide(0n)).toBe(false);
  });

  it("delivers a tip above the cost", () => {
    expect(decide(1_200n)).toBe(true);
  });

  it("asks for a tip that covers the cost when the allowed loss is 0 percent: break-even delivers, one wei below does not", () => {
    expect(decide(1_001n, 0)).toBe(true);
    expect(decide(1_000n, 0)).toBe(true);
    expect(decide(999n, 0)).toBe(false);
  });

  it("treats a tip of nothing on a cost above zero as a full loss, whatever the limit below 100 percent", () => {
    expect(decide(0n, 99)).toBe(false);
  });

  it("delivers anything when the allowed loss is 100 percent, except a tip of nothing", () => {
    expect(decide(1n, 100)).toBe(true);
    expect(decide(0n, 100)).toBe(false);
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
