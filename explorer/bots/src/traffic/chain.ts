import { decodeEventLog, encodeFunctionData, erc20Abi, maxUint256, toFunctionSelector, toFunctionSignature, type Address, type Hex, type PublicClient } from "viem";
import { beaconForkGateAbi, messageBridgeAbi, tokenFactoryAbi, tokenMediatorAbi } from "@zk-bridge/shared";
import type { ReceiptLog } from "../chain/transactions.ts";

/** What the traffic bot reads on one chain. The real one sits on a viem client; tests pass a fake. */
export interface TrafficReader {
  /** The native coin of an account, in wei. */
  nativeBalance(account: Address): Promise<bigint>;
  /** The balance of an account in a token. Zero when the token has no code yet (a copy before its first delivery). */
  tokenBalance(token: Address, account: Address): Promise<bigint>;
  /** The allowance of an owner to a spender. Zero when the token has no code. */
  allowance(token: Address, owner: Address, spender: Address): Promise<bigint>;
  /** Whether an address holds code: whether a bridged copy exists yet. */
  hasCode(address: Address): Promise<boolean>;
  /** The address of the bridged copy, on this chain, of a token that is native on `homeChainId`. */
  copyAddress(input: { readonly tokenFactory: Address; readonly homeChainId: number; readonly nativeToken: Address }): Promise<Address>;
}

/** Builds the reader over a viem client. */
export function createTrafficReader(client: Pick<PublicClient, "getBalance" | "getCode" | "readContract">): TrafficReader {
  const hasCode = async (address: Address): Promise<boolean> => {
    const code = await client.getCode({ address });
    return code !== undefined && code !== "0x";
  };
  return {
    hasCode,
    nativeBalance: (account) => client.getBalance({ address: account }),
    async tokenBalance(token, account) {
      if (!(await hasCode(token))) return 0n;
      return (await client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [account] })) as bigint;
    },
    async allowance(token, owner, spender) {
      if (!(await hasCode(token))) return 0n;
      return (await client.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [owner, spender] })) as bigint;
    },
    async copyAddress(input) {
      return (await client.readContract({
        address: input.tokenFactory,
        abi: tokenFactoryAbi,
        functionName: "predictAddress",
        args: [BigInt(input.homeChainId), input.nativeToken],
      })) as Address;
    },
  };
}

/** The approval that lets the mediator pull the token: the largest amount, once. Test tokens only. */
export function approvalData(spender: Address): Hex {
  return encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, maxUint256] });
}

/**
 * The relay with fee terms: the tokens go to the delivery router of the destination, with the encoded director. With a
 * gas limit the relay asks for it (the overload with five arguments); without one the mediator picks its default.
 */
export function relayData(input: { readonly token: Address; readonly router: Address; readonly amount: bigint; readonly terms: Hex; readonly gasLimit?: bigint | null }): Hex {
  if (input.gasLimit === undefined || input.gasLimit === null) {
    return encodeFunctionData({ abi: tokenMediatorAbi, functionName: "relayTokensAndCall", args: [input.token, input.router, input.amount, input.terms] });
  }
  return encodeFunctionData({ abi: tokenMediatorAbi, functionName: "relayTokensAndCall", args: [input.token, input.router, input.amount, input.terms, input.gasLimit] });
}

/**
 * The message identifier of the bridge's `UserRequestForAffirmation` log in a receipt, or null when the receipt holds none.
 */
export function messageIdOf(logs: readonly ReceiptLog[], bridge: Address): Hex | null {
  for (const log of logs) {
    if (log.address.toLowerCase() !== bridge.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({ abi: messageBridgeAbi, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
      if (decoded.eventName === "UserRequestForAffirmation") return (decoded.args as { messageId: Hex }).messageId;
    } catch {
      // Another event of the bridge.
    }
  }
  return null;
}

/** The errors that a refused relay names, by selector, from the mediator, the bridge and the gate. */
const ERROR_NAMES: ReadonlyMap<string, string> = new Map(
  [...tokenMediatorAbi, ...messageBridgeAbi, ...beaconForkGateAbi]
    .filter((item): item is Extract<typeof item, { readonly type: "error" }> => item.type === "error")
    // The object form of `toFunctionSelector` hashes "error Name(...)" for an error item: drop the keyword first.
    .map((item) => [toFunctionSelector(toFunctionSignature(item as never).replace(/^error /, "")), item.name]),
);

/** Why a relay would revert, as a skip reason of the traffic bot. */
export type RelayRefusal = "gate-not-confirmed" | "deposits-not-open" | "relay-simulation-reverted";

/**
 * Reads the reason of a failed simulation (`... (revert data 0x12345678)`, as the transaction port gives it) and names
 * the refusal. A send from a chain whose gate is enforcing needs a confirmation of the current epoch first
 * (`ForkNotConfirmed`); a bridge that is still locked refuses every send (`DepositsNotOpen`).
 */
export function relayRefusalOf(reason: string): { readonly refusal: RelayRefusal; readonly error: string | null } {
  const selector = /revert data (0x[0-9a-fA-F]{8})/.exec(reason)?.[1]?.toLowerCase();
  const error = selector === undefined ? null : (ERROR_NAMES.get(selector) ?? selector);
  if (error === "ForkNotConfirmed") return { refusal: "gate-not-confirmed", error };
  if (error === "DepositsNotOpen") return { refusal: "deposits-not-open", error };
  return { refusal: "relay-simulation-reverted", error };
}
