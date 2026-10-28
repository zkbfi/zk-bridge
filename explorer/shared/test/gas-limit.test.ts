import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import * as gas from "../src/gas-limit.js";

const root = resolve(import.meta.dirname, "../../..");
const source = (path: string): string => readFileSync(resolve(root, path), "utf8");

describe("the gas rule", () => {
  it("requiredDeliveryGas mirrors the bridge guard", () => {
    expect(gas.requiredDeliveryGas(1_000_000n)).toBe(1_115_874n);
  });

  it("a deploy with 500 bytes of name and symbol needs 2_100_000", () => {
    expect(gas.minimumGasLimitOf({ kind: "token-deploy", withCall: false, nameAndSymbolBytes: 500 })).toBe(2_100_000n);
  });

  it("a short deploy gets the deploy floor, and a callback adds to every token kind", () => {
    expect(gas.minimumGasLimitOf({ kind: "token-deploy", withCall: false, nameAndSymbolBytes: 10 })).toBe(2_000_000n);
    expect(gas.minimumGasLimitOf({ kind: "token-deploy", withCall: true, nameAndSymbolBytes: 10 })).toBe(2_750_000n);
    expect(gas.minimumGasLimitOf({ kind: "token-release", withCall: true })).toBe(1_000_000n);
    expect(gas.minimumGasLimitOf({ kind: "token-release", withCall: false })).toBe(250_000n);
    expect(gas.minimumGasLimitOf({ kind: "plain-message" })).toBe(100n);
  });

  it("zero gives the default", () => {
    expect(gas.checkRequestedGasLimit({ kind: { kind: "token-release", withCall: false }, requested: 0n })).toEqual({
      ok: true,
      gasLimit: 250_000n,
    });
  });

  it("a request at or above the minimum passes unchanged", () => {
    const kind = { kind: "token-release", withCall: false } as const;
    expect(gas.checkRequestedGasLimit({ kind, requested: 250_000n })).toEqual({ ok: true, gasLimit: 250_000n });
    expect(gas.checkRequestedGasLimit({ kind, requested: 10_000_000n })).toEqual({ ok: true, gasLimit: 10_000_000n });
  });

  it("249_999 for a plain release is below-minimum with minimum 250_000", () => {
    expect(
      gas.checkRequestedGasLimit({ kind: { kind: "token-release", withCall: false }, requested: 249_999n }),
    ).toEqual({ ok: false, reason: "below-minimum", minimum: 250_000n, maximum: 10_000_000n });
  });

  it("10_000_001 is above-maximum", () => {
    expect(
      gas.checkRequestedGasLimit({ kind: { kind: "token-release", withCall: false }, requested: 10_000_001n }),
    ).toEqual({ ok: false, reason: "above-maximum", minimum: 250_000n, maximum: 10_000_000n });
  });

  it("the constants equal the Solidity source", () => {
    const text = `${source("src/hardened/mediator/TokenMediator.sol")}\n${source("src/hardened/MessageBridge.sol")}`;
    const names = [
      "MIN_GAS_PER_CALL",
      "MAX_GAS_PER_TX",
      "EXECUTION_OVERHEAD_GAS",
      "RELEASE_GAS_LIMIT",
      "CALLBACK_GAS_LIMIT",
      "DEPLOY_GAS_LIMIT",
      "DEPLOY_GAS_BASE",
      "DEPLOY_GAS_PER_BYTE",
    ] as const;
    for (const name of names) {
      const match = new RegExp(`constant ${name} = ([0-9_]+);`).exec(text);
      expect(match, name).not.toBeNull();
      expect(gas[name], name).toBe(BigInt((match as RegExpExecArray)[1].replaceAll("_", "")));
    }
  });
});
