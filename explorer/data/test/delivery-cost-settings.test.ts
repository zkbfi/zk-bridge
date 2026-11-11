import { describe, expect, it } from "vitest";
import { parseDeliveryCostSettings } from "../src/delivery-cost-settings.js";

describe("parseDeliveryCostSettings", () => {
  it("uses the documented defaults and holds no proof setting", () => {
    expect(parseDeliveryCostSettings({})).toEqual({ sampleLimit: 200, defaultGas: 600_000n });
  });

  it("reads every variable, and ignores the old proof and coin price variables", () => {
    const settings = parseDeliveryCostSettings({
      EXPLORER_DELIVERY_SAMPLE_LIMIT: "50",
      EXPLORER_DEFAULT_DELIVERY_GAS: "650000",
      EXPLORER_PROOF_COST_USD: "0.5",
      EXPLORER_NATIVE_COIN_PRICE_USD_369: "0.00005",
    });
    expect(settings).toEqual({ sampleLimit: 50, defaultGas: 650_000n });
  });

  it("refuses a count that passes the safe integer range", () => {
    expect(() => parseDeliveryCostSettings({ EXPLORER_DELIVERY_SAMPLE_LIMIT: "9007199254740992" })).toThrow(
      "EXPLORER_DELIVERY_SAMPLE_LIMIT is too large: 9007199254740992",
    );
    expect(parseDeliveryCostSettings({ EXPLORER_DELIVERY_SAMPLE_LIMIT: "9007199254740991" }).sampleLimit).toBe(Number.MAX_SAFE_INTEGER);
  });

  it.each([
    ["EXPLORER_DELIVERY_SAMPLE_LIMIT", "0"],
    ["EXPLORER_DELIVERY_SAMPLE_LIMIT", "ten"],
    ["EXPLORER_DEFAULT_DELIVERY_GAS", "-5"],
    ["EXPLORER_DEFAULT_DELIVERY_GAS", "1.5"],
  ])("names %s when the value is %s", (name, value) => {
    expect(() => parseDeliveryCostSettings({ [name]: value })).toThrow(new RegExp(name));
  });
});
