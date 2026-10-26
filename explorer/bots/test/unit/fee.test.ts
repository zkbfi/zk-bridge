import { describe, expect, it } from "vitest";
import { decideDelivery, payoutOfOffer, readFeeOffer, valueFeeInWei } from "../../src/runner/fee.ts";
import { DELIVERY_ROUTER, OTHER_TOKEN, WRAPPED_NATIVE, address, feeOfferData } from "../support/builders.ts";
import { encodeFunctionData } from "viem";
import { tokenMediatorAbi } from "@zk-bridge/shared";

const director = { recipient: address(0x12), settings: 8n, limit: 0n, multiplier: 10n ** 16n };

describe("reading the fee offer", () => {
  it("reads the FeeDirector from the callback data of a message to the delivery router", () => {
    const offer = readFeeOffer({ messageData: feeOfferData({ director, value: 5000n }), deliveryRouter: DELIVERY_ROUTER });
    expect(offer).toEqual({ kind: "offer", director, value: 5000n });
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
    const legacy = encodeFunctionData({ abi: tokenMediatorAbi, functionName: "handleBridgedTokensAndCall", args: [OTHER_TOKEN, DELIVERY_ROUTER, 1n, address(0x14)] });
    expect(reason(legacy)).toBe("legacy-native-receiver");
    const short = encodeFunctionData({ abi: tokenMediatorAbi, functionName: "handleBridgedTokensAndCall", args: [OTHER_TOKEN, DELIVERY_ROUTER, 1n, "0x1234"] });
    expect(reason(short)).toBe("unknown-callback-data");
    const empty = encodeFunctionData({ abi: tokenMediatorAbi, functionName: "handleBridgedTokensAndCall", args: [OTHER_TOKEN, DELIVERY_ROUTER, 1n, "0x"] });
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
  const quote = { baseFee: 7n, priorityFee: 3n };

  it("delivers when the fee equals cost plus margin, and not one wei below", () => {
    expect(decideDelivery({ feeWei: 1_050n, gasUnits: 100n, quote, minimumMarginWei: 50n })).toEqual({ deliver: true, costWei: 1_000n, profitWei: 50n });
    expect(decideDelivery({ feeWei: 1_049n, gasUnits: 100n, quote, minimumMarginWei: 50n })).toEqual({ deliver: false, costWei: 1_000n, shortfallWei: 1n });
  });

  it("prices gas at the base fee plus the priority fee", () => {
    const decision = decideDelivery({ feeWei: 0n, gasUnits: 1n, quote: { baseFee: 100n, priorityFee: 0n }, minimumMarginWei: 0n });
    expect(decision.costWei).toBe(100n);
  });
});
