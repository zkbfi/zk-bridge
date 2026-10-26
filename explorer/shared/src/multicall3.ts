import { decodeFunctionResult, encodeFunctionData, keccak256, type Address, type Hex } from "viem";
import { multicall3Abi } from "./abis/index.js";

/** The address of Multicall3 on most chains. A chain without it needs a deployment, and the configuration names its address. */
export const MULTICALL3_ADDRESS: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";

/** One call of a batch. Every call allows failure, so one revert never reverts the others. */
export interface BatchedCall {
  readonly target: Address;
  readonly callData: Hex;
}

/** What Multicall3 reports for one call: whether it succeeded, and its return data or its revert data. */
export interface BatchedCallResult {
  /** The position of the call in the batch. */
  readonly position: number;
  readonly success: boolean;
  readonly returnData: Hex;
  /** `keccak256` of the return data for a failed call, else the zero hash. The runner logs it in place of the data. */
  readonly revertDataHash: Hex;
}

const ZERO_HASH: Hex = `0x${"00".repeat(32)}`;

/** Encodes `aggregate3` with `allowFailure` set on every call. */
export function encodeAggregate3(calls: readonly BatchedCall[]): Hex {
  return encodeFunctionData({
    abi: multicall3Abi,
    functionName: "aggregate3",
    args: [calls.map((call) => ({ target: call.target, allowFailure: true, callData: call.callData }))],
  });
}

/** Reads the answer of `aggregate3`, one result per call in the order of the batch. */
export function decodeAggregate3(data: Hex): readonly BatchedCallResult[] {
  const returned = decodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3", data });
  return returned.map((result, position) => ({
    position,
    success: result.success,
    returnData: result.returnData,
    revertDataHash: result.success ? ZERO_HASH : keccak256(result.returnData),
  }));
}
