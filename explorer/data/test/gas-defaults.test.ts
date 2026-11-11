import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BACKEND_START_DELIVERY_GAS, DEFAULT_DELIVERY_GAS } from "../src/delivery-cost-settings.js";

/** The one source of the start figure: `deploy/gas-defaults.json`, which the forge test also reads. */
const file = JSON.parse(readFileSync(new URL("../../../deploy/gas-defaults.json", import.meta.url), "utf8")) as { backendStartDeliveryGas: number };

describe("deploy/gas-defaults.json", () => {
  it("holds the start figure of the backend that the constant carries", () => {
    expect(BigInt(file.backendStartDeliveryGas)).toBe(BACKEND_START_DELIVERY_GAS);
  });

  it("stays below the explorer default, which covers the dearer first delivery through the router", () => {
    expect(BACKEND_START_DELIVERY_GAS).toBeLessThan(DEFAULT_DELIVERY_GAS);
  });
});
