import { decodeFunctionData, type Address, type Hex } from "viem";
import { tokenMediatorAbi } from "./abis/index.js";
import { normalizeAddress } from "@zkb/core";

/** What a message to a token mediator asks it to do. */
export type MediatorMessage = {
  /** The name of the handler function in the message. */
  readonly handler: string;
  /**
   * The token in the frame of the handler. A `handleNative*` message names a token that is native on the
   * destination. Other handlers name the native token of the source chain, and the destination holds its copy.
   */
  readonly token: Address;
  /** True when the destination token is native there (the transfer unlocks). False when it is a bridged copy (mints). */
  readonly releasesNativeToken: boolean;
  /** True when the first delivery deploys the bridged copy. */
  readonly deploysCopy: boolean;
  readonly recipient: Address;
  readonly value: bigint;
  /** The callback data, or null for a plain release. */
  readonly callbackData: Hex | null;
  /** Name, symbol and decimals, for a deploying message only. */
  readonly metadata: { readonly name: string; readonly symbol: string; readonly decimals: number } | null;
};

const asAddress = (value: unknown): Address => normalizeAddress(String(value));

/**
 * Decodes the call data of an Arbitrary Message Bridge message as a mediator handler call.
 *
 * @param data The call data of the message.
 * @returns The decoded call, or null when the data is not a mediator handler call (an arbitrary message).
 */
export const decodeMediatorMessage = (data: Hex): MediatorMessage | null => {
  let decoded;
  try {
    decoded = decodeFunctionData({ abi: tokenMediatorAbi, data });
  } catch {
    return null;
  }
  const handler = decoded.functionName;
  if (!/^(handle(Native|Bridged)Tokens|deployAndHandleBridgedTokens)/.test(handler)) return null;
  // The decoder took the name from this ABI, so the item exists. A handler has named inputs and so has arguments.
  const item = tokenMediatorAbi.find((entry) => entry.type === "function" && entry.name === handler) as FunctionItem;
  const named = namedArguments(item, decoded.args as readonly unknown[]);
  return {
    handler,
    token: asAddress(named.token),
    releasesNativeToken: handler.startsWith("handleNative"),
    deploysCopy: handler.startsWith("deployAndHandle"),
    recipient: asAddress(named.recipient),
    value: named.value as bigint,
    callbackData: handler.includes("AndCall") ? (named.data as Hex) : null,
    metadata: handler.startsWith("deployAndHandle")
      ? { name: named.name as string, symbol: named.symbol as string, decimals: Number(named.decimals) }
      : null,
  };
};

type FunctionItem = Extract<(typeof tokenMediatorAbi)[number], { readonly type: "function" }>;

/** Pairs the positional arguments of a decoded call with the parameter names of its ABI item. */
const namedArguments = (item: FunctionItem, args: readonly unknown[]): Record<string, unknown> =>
  Object.fromEntries(item.inputs.map((input, index) => [input.name, args[index]]));
