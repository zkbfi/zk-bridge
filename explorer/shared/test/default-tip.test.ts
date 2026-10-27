import { describe, expect, it } from "vitest";
import { defaultTipChoiceOf, type DefaultTipChoiceInput } from "../src/default-tip.js";

const base: DefaultTipChoiceInput = { senderPrice: null, tokenValueInWei: 10n ** 18n, tokenDecimals: 18, chainName: "PulseChain" };

describe("the default tip choice", () => {
  it("is the gas based mode at the base fee on a chain that reports a base fee, with no notice", () => {
    const choice = defaultTipChoiceOf(base);
    expect(choice.mode).toBe("gas");
    expect(choice.gasPrice).toBe("base-fee-only");
    expect(choice.priceSource).toBe("valuation");
    expect(choice.notice).toBeNull();
    expect(choice.senderPrice).toEqual({ numerator: 10n ** 18n, denominator: 10n ** 18n });
  });

  it("falls back to the whole gas price on a chain with no base fee, and says why", () => {
    const choice = defaultTipChoiceOf({ ...base, destinationBaseFee: "none", chainName: "BNB Smart Chain" });
    expect(choice.gasPrice).toBe("transaction");
    expect(choice.notice).toBe("BNB Smart Chain reports no base fee, so the tip reads the whole gas price.");
  });

  it("prefers the price that the sender typed to the price of the valuation", () => {
    const typed = { numerator: 3n, denominator: 7n };
    const choice = defaultTipChoiceOf({ ...base, senderPrice: typed });
    expect(choice.priceSource).toBe("sender");
    expect(choice.senderPrice).toBe(typed);
  });

  it("asks for a price when there is neither a typed price nor a valuation, because a fixed tip needs the same price", () => {
    const choice = defaultTipChoiceOf({ ...base, tokenValueInWei: null });
    expect(choice.priceSource).toBe("missing");
    expect(choice.senderPrice).toBeNull();
    expect(choice.mode).toBe("gas");
    expect(choice.notice).toContain("Enter your price of the native coin");
    expect(choice.notice).toContain("Percentage and fixed amount stay available");
  });

  it("gives both notices when the chain has no base fee and no price exists", () => {
    const choice = defaultTipChoiceOf({ ...base, tokenValueInWei: null, destinationBaseFee: "none" });
    expect(choice.notice).toContain("reports no base fee");
    expect(choice.notice).toContain("Enter your price");
  });
});
