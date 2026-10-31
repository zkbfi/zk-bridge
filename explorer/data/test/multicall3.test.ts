import { describe, expect, it } from "vitest";
import { decodeFunctionData, encodeFunctionResult, keccak256, zeroHash, type Hex } from "viem";
import { decodeAggregate3, encodeAggregate3, MULTICALL3_ADDRESS, multicall3Abi } from "../src/index.js";

const target = "0x00000000000000000000000000000000000000A1" as const;

describe("encodeAggregate3", () => {
  /** Claim: every call of the batch allows failure, in the order given. Matters: one failed delivery must not revert the others. */
  it("allows failure on every call and keeps the order", () => {
    const data = encodeAggregate3([
      { target, callData: "0x11" },
      { target, callData: "0x22" },
    ]);
    const decoded = decodeFunctionData({ abi: multicall3Abi, data });
    expect(decoded.functionName).toBe("aggregate3");
    expect(decoded.args?.[0]).toEqual([
      { target, allowFailure: true, callData: "0x11" },
      { target, allowFailure: true, callData: "0x22" },
    ]);
  });

  it("names the canonical address", () => {
    expect(MULTICALL3_ADDRESS).toBe("0xcA11bde05977b3631167028862bE2a173976CA11");
  });
});

describe("decodeAggregate3", () => {
  /** Claim: a failed call carries the hash of its revert data, a successful call carries the zero hash. */
  it("numbers the results and hashes the revert data of failures only", () => {
    const revertData: Hex = "0xdeadbeef";
    const data = encodeFunctionResult({
      abi: multicall3Abi,
      functionName: "aggregate3",
      result: [
        { success: true, returnData: "0x" },
        { success: false, returnData: revertData },
      ],
    });
    expect(decodeAggregate3(data)).toEqual([
      { position: 0, success: true, returnData: "0x", revertDataHash: zeroHash },
      { position: 1, success: false, returnData: revertData, revertDataHash: keccak256(revertData) },
    ]);
  });
});
