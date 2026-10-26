import { describe, expect, it } from "vitest";
import { parseDeliveryCostSettings } from "../../src/lib/delivery-cost-settings";

describe("parseDeliveryCostSettings", () => {
  it("uses the documented defaults and no coin price", () => {
    expect(parseDeliveryCostSettings({}, [1, 369])).toEqual({
      sampleLimit: 200,
      defaultGas: 550_000n,
      proofCostUsd: "0.02",
      deliveriesPerProof: 1,
      nativeCoinPriceUsdByChain: {},
    });
  });

  it("reads every variable", () => {
    const settings = parseDeliveryCostSettings(
      {
        EXPLORER_DELIVERY_SAMPLE_LIMIT: "50",
        EXPLORER_DEFAULT_DELIVERY_GAS: "600000",
        EXPLORER_PROOF_COST_USD: "0.5",
        EXPLORER_DELIVERIES_PER_PROOF: "4",
        EXPLORER_NATIVE_COIN_PRICE_USD_369: "0.00005",
        EXPLORER_NATIVE_COIN_PRICE_USD_5: "1",
      },
      [1, 369],
    );
    expect(settings).toEqual({
      sampleLimit: 50,
      defaultGas: 600_000n,
      proofCostUsd: "0.5",
      deliveriesPerProof: 4,
      nativeCoinPriceUsdByChain: { 369: "0.00005" },
    });
  });

  it("refuses a count that passes the safe integer range", () => {
    expect(() => parseDeliveryCostSettings({ EXPLORER_DELIVERY_SAMPLE_LIMIT: "9007199254740992" }, [])).toThrow(
      "EXPLORER_DELIVERY_SAMPLE_LIMIT is too large: 9007199254740992",
    );
    expect(parseDeliveryCostSettings({ EXPLORER_DELIVERY_SAMPLE_LIMIT: "9007199254740991" }, []).sampleLimit).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("trims a value and says why a coin price is not usable", () => {
    expect(parseDeliveryCostSettings({ EXPLORER_PROOF_COST_USD: " 0.5 " }, []).proofCostUsd).toBe("0.5");
    expect(() => parseDeliveryCostSettings({ EXPLORER_NATIVE_COIN_PRICE_USD_369: "0" }, [369])).toThrow(/^EXPLORER_NATIVE_COIN_PRICE_USD_369 is not usable: /);
  });

  it.each([
    ["EXPLORER_DELIVERY_SAMPLE_LIMIT", "0"],
    ["EXPLORER_DELIVERY_SAMPLE_LIMIT", "ten"],
    ["EXPLORER_DEFAULT_DELIVERY_GAS", "-5"],
    ["EXPLORER_DEFAULT_DELIVERY_GAS", "1.5"],
    ["EXPLORER_DELIVERIES_PER_PROOF", "0"],
    ["EXPLORER_PROOF_COST_USD", "2e-2"],
    ["EXPLORER_NATIVE_COIN_PRICE_USD_369", "cheap"],
    ["EXPLORER_NATIVE_COIN_PRICE_USD_369", "0"],
  ])("names %s when the value is %s", (name, value) => {
    expect(() => parseDeliveryCostSettings({ [name]: value }, [369])).toThrow(new RegExp(name));
  });
});
