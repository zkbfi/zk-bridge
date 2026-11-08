/**
 * Plain text for a revert: the custom errors of the bridge contracts (the deposit gate, the message bridge, the token
 * mediator, the delivery router and the bridged token), `Error(string)` and `Panic(uint256)`, decoded from the revert
 * data that a viem error carries along its causes. A revert with no data, or data that no known error matches, keeps
 * the node's own message.
 */
import { beaconForkGateAbi, bridgedTokenAbi, deliveryRouterAbi, messageBridgeAbi, tokenMediatorAbi } from "@zk-bridge/shared";
import { decodeErrorResult, toFunctionSelector, type Abi, type Hex } from "viem";

type AbiError = Extract<Abi[number], { type: "error" }>;

/** A decoded revert: the error name and its arguments by name (or by position when unnamed). */
export type DecodedRevert = {
  readonly name: string;
  readonly args: readonly unknown[];
  /** The input names of the error, in order. */
  readonly inputNames: readonly (string | undefined)[];
};

const errorKey = (item: AbiError): string => toFunctionSelector(`function ${item.name}(${item.inputs.map((input) => input.type).join(",")})`);

/** Every custom error of the bridge contracts, one entry per selector. */
export const BRIDGE_ERROR_ABI: Abi = (() => {
  const seen = new Set<string>();
  const errors: AbiError[] = [];
  for (const abi of [beaconForkGateAbi, messageBridgeAbi, tokenMediatorAbi, deliveryRouterAbi, bridgedTokenAbi] as readonly Abi[]) {
    for (const item of abi) {
      if (item.type !== "error") continue;
      const key = errorKey(item);
      if (seen.has(key)) continue;
      seen.add(key);
      errors.push(item);
    }
  }
  return errors;
})();

/** The first revert data (hex of at least a selector) along the causes of an error. */
export const revertDataOf = (error: unknown): Hex | null => {
  let cause = error as { data?: unknown; cause?: unknown } | null | undefined;
  for (let depth = 0; cause !== undefined && cause !== null && depth < 10; depth += 1) {
    const data = typeof cause.data === "object" && cause.data !== null ? (cause.data as { data?: unknown }).data : cause.data;
    if (typeof data === "string" && /^0x[0-9a-fA-F]{8,}$/.test(data)) return data as Hex;
    cause = cause.cause as typeof cause;
  }
  return null;
};

/** The error in the revert data of an error, or null when it carries none that a known ABI decodes. */
export const decodeRevert = (error: unknown): DecodedRevert | null => {
  const data = revertDataOf(error);
  if (data === null) return null;
  try {
    const decoded = decodeErrorResult({ abi: BRIDGE_ERROR_ABI, data });
    return { name: decoded.errorName, args: decoded.args ?? [], inputNames: (decoded.abiItem as AbiError).inputs.map((input) => input.name) };
  } catch {
    return null;
  }
};

const valueText = (value: unknown): string => String(value);

/** Where the revert happened, for the sentences. */
export type RevertContext = {
  /** The chain of the transaction, such as `Sepolia`. */
  readonly chainName: string;
};

/**
 * A sentence for a revert, or null when the error carries no revert data that a known error matches.
 *
 * @param error The error of an estimate or a call.
 * @param context The chain, for the sentences.
 */
export const revertText = (error: unknown, context: RevertContext): string | null => {
  const decoded = decodeRevert(error);
  if (decoded === null) {
    const data = revertDataOf(error);
    return data === null ? null : `The contract reverted with the error ${data.slice(0, 10)}, which no bridge contract defines.`;
  }
  const { name, args } = decoded;
  switch (name) {
    case "ForkNotConfirmed":
      return `The ${context.chainName} deposit gate needs epoch ${valueText(args[0])} confirmed first. A send in this epoch reverts until one transaction confirms it.`;
    case "GateSealed":
      return `The ${context.chainName} deposit gate is sealed. It admits no send.`;
    case "HeaderNotInCurrentEpoch":
      return `The confirmation names a beacon header of epoch ${valueText(args[0])}, and the chain is in epoch ${valueText(args[1])} now. A new confirmation is needed.`;
    case "Error":
      return `The contract reverted: ${valueText(args[0])}.`;
    case "Panic":
      return `The contract stopped with panic code 0x${(args[0] as bigint).toString(16)}.`;
    default: {
      const parts = args.map((value, index) => [decoded.inputNames[index], valueText(value)].filter(Boolean).join(" "));
      return `The contract reverted with ${name}${parts.length === 0 ? "" : ` (${parts.join(", ")})`}.`;
    }
  }
};

/** Whether an error is the gate's `ForkNotConfirmed(epoch)` revert. */
export const isForkNotConfirmed = (error: unknown): boolean => decodeRevert(error)?.name === "ForkNotConfirmed";
