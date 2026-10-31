import { describe, expect, it } from "vitest";
import { selfDeliveryState } from "../../src/bridge/self-delivery";

describe("deliver it yourself", () => {
  it("is open when the wallet can pay the gas", () => {
    expect(selfDeliveryState({ nativeBalance: 10n ** 16n, estimatedGasWei: 9n * 10n ** 14n, symbol: "ETH", chainName: "Ethereum" })).toEqual({ enabled: true, reason: null });
  });

  it("is closed when it cannot, saying what it holds, what is needed and what to add", () => {
    const state = selfDeliveryState({ nativeBalance: 31n * 10n ** 12n, estimatedGasWei: 9n * 10n ** 14n, symbol: "ETH", chainName: "Ethereum" });
    expect(state.enabled).toBe(false);
    expect(state.reason).toMatch(/holds 0.000031 ETH on Ethereum/);
    expect(state.reason).toMatch(/needs about 0.0009 ETH/);
    expect(state.reason).toMatch(/Add 0.000869 ETH on Ethereum/);
  });

  it("asks for a wallet when none is connected", () => {
    expect(selfDeliveryState({ nativeBalance: null, estimatedGasWei: 1n, symbol: "ETH", chainName: "Ethereum" }).enabled).toBe(false);
  });
});
