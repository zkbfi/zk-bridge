import { describe, expect, test } from "bun:test";
import { MAX_GAS_PER_TX, requiredDeliveryGas } from "@zk-bridge/shared";
import { parseUnits } from "viem";
import { coveringTipFor } from "../src/stages/bots";

describe("coveringTipFor", () => {
  test("is worth more than the cost of the costliest delivery, so the runner delivers at a loss limit of zero", () => {
    const gasPrice = 10_723n;
    const tipWei = (parseUnits(coveringTipFor(gasPrice), 18) * 10n ** 15n) / 10n ** 18n;
    expect(tipWei).toBeGreaterThan(requiredDeliveryGas(MAX_GAS_PER_TX) * gasPrice);
  });

  test("grows with the gas price", () => {
    expect(parseUnits(coveringTipFor(2_000n), 18)).toBeGreaterThan(parseUnits(coveringTipFor(1_000n), 18));
  });
});
