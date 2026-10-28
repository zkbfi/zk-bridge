import { parseAbi, type Address } from "viem";
import { tokenMediatorAbi } from "./abis/index.js";
import { ZERO_ADDRESS } from "./address.js";
import type { ContractReader } from "./token-facts.js";

/**
 * The gas rule for a bridge message, as the contracts enforce it. Bots, the dapp and the terminal use this module so
 * that no layer guesses its own number. Every constant below equals a constant in the Solidity source; a test reads
 * the source and checks that they match.
 */

/** The least gas that the message bridge accepts for one call. */
export const MIN_GAS_PER_CALL = 100n;
/** The most gas that the message bridge accepts for one message. */
export const MAX_GAS_PER_TX = 10_000_000n;
/** The gas that a delivery keeps for its own work around the call of the message. */
export const EXECUTION_OVERHEAD_GAS = 100_000n;
/** The gas that the mediator gives the release of tokens. */
export const RELEASE_GAS_LIMIT = 250_000n;
/** The extra gas for the callback of a release with a call. */
export const CALLBACK_GAS_LIMIT = 750_000n;
/** The least gas for a message that deploys a bridged copy. */
export const DEPLOY_GAS_LIMIT = 2_000_000n;
/** The base of the deploy rule, before the gas for the name and the symbol. */
export const DEPLOY_GAS_BASE = 1_300_000n;
/** The gas for each byte of name and symbol together in a deploy message. */
export const DEPLOY_GAS_PER_BYTE = 1_600n;

/** The kinds of message that have their own minimum gas limit. */
export type MessageKind =
  | { kind: "plain-message" }
  | { kind: "token-release"; withCall: boolean }
  | { kind: "token-deploy"; withCall: boolean; nameAndSymbolBytes: number };

/** The result of a check on a requested gas limit. */
export type GasLimitCheck =
  | { ok: true; gasLimit: bigint }
  | { ok: false; reason: "below-minimum" | "above-maximum"; minimum: bigint; maximum: bigint };

const callbackGasOf = (withCall: boolean): bigint => (withCall ? CALLBACK_GAS_LIMIT : 0n);

const deployGasOf = (nameAndSymbolBytes: number): bigint => {
  if (!Number.isInteger(nameAndSymbolBytes) || nameAndSymbolBytes < 0) {
    throw new RangeError(`nameAndSymbolBytes must be a non-negative whole number, got ${nameAndSymbolBytes}`);
  }
  const needed = DEPLOY_GAS_BASE + DEPLOY_GAS_PER_BYTE * BigInt(nameAndSymbolBytes);
  return needed > DEPLOY_GAS_LIMIT ? needed : DEPLOY_GAS_LIMIT;
};

/**
 * The least gas limit that a message of this kind may carry. For a token kind it is also the default that a request
 * of zero receives. For a plain message, 100 is the floor of the message bridge and not a default: the bridge refuses
 * zero.
 *
 * The mediator enforces the same rule: a token request above zero and below the default reverts with
 * `GasLimitBelowMinimum`.
 * @param kind The kind of the message, with the facts that change its minimum.
 */
export function minimumGasLimitOf(kind: MessageKind): bigint {
  if (kind.kind === "plain-message") return MIN_GAS_PER_CALL;
  if (kind.kind === "token-release") return RELEASE_GAS_LIMIT + callbackGasOf(kind.withCall);
  return deployGasOf(kind.nameAndSymbolBytes) + callbackGasOf(kind.withCall);
}

/**
 * Checks a requested gas limit against the rule. For a token kind, zero means the default, which is the minimum. For a
 * plain message, zero is below the minimum, because the message bridge refuses it.
 * @param input The kind of the message and the gas limit that the sender asks for.
 */
export function checkRequestedGasLimit(input: { kind: MessageKind; requested: bigint }): GasLimitCheck {
  const minimum = minimumGasLimitOf(input.kind);
  const maximum = MAX_GAS_PER_TX;
  if (input.requested === 0n && input.kind.kind !== "plain-message") return { ok: true, gasLimit: minimum };
  if (input.requested < minimum) return { ok: false, reason: "below-minimum", minimum, maximum };
  if (input.requested > maximum) return { ok: false, reason: "above-maximum", minimum, maximum };
  return { ok: true, gasLimit: input.requested };
}

/**
 * The gas that a delivery must have for a message: the limit, the share that the call keeps back (one sixty-third),
 * one unit, and the overhead. This mirrors the guard in the message bridge.
 * @param messageGasLimit The gas limit that the message carries.
 */
export function requiredDeliveryGas(messageGasLimit: bigint): bigint {
  return messageGasLimit + messageGasLimit / 63n + 1n + EXECUTION_OVERHEAD_GAS;
}

/**
 * What decides the kind of the first message of a relay, read from the mediator of the source chain:
 * - `copy`: the token is a bridged copy (`nativeTokenAddress` is not zero), so the mediator sends a release;
 * - `acknowledged`: a native token whose copy the other chain proved (`isBridgedTokenDeployAcknowledged`), so a release;
 * - `unacknowledged`: a native token with no proof yet, so the mediator sends a deploy, whose minimum grows with the
 *   byte length of the name and the symbol.
 */
export type RelayGasFacts =
  | { kind: "copy" }
  | { kind: "acknowledged" }
  | { kind: "unacknowledged"; nameAndSymbolBytes: number };

const textViewsAbi = parseAbi(["function name() view returns (string)", "function symbol() view returns (string)"]);
const textViewsAsWordAbi = parseAbi(["function name() view returns (bytes32)", "function symbol() view returns (bytes32)"]);
const upperViewsAbi = parseAbi(["function NAME() view returns (string)", "function SYMBOL() view returns (string)"]);
const upperViewsAsWordAbi = parseAbi(["function NAME() view returns (bytes32)", "function SYMBOL() view returns (bytes32)"]);

const wordLength = (word: string): number => {
  for (let index = 2; index < word.length; index += 2) {
    if (word.slice(index, index + 2) === "00") return (index - 2) / 2;
  }
  return (word.length - 2) / 2;
};

/**
 * Reads one text view of a token the way `TokenReader` does on chain: the lower case name, then the upper case name; a
 * string, or a `bytes32` that ends at its first zero byte. A token that answers none of them has a text of length zero.
 * @returns The length of the text in bytes.
 */
const readTextBytes = async (reader: ContractReader, token: Address, which: "name" | "symbol"): Promise<number> => {
  const upper = which.toUpperCase();
  const attempts = [
    { abi: textViewsAbi, functionName: which, isWord: false },
    { abi: textViewsAsWordAbi, functionName: which, isWord: true },
    { abi: upperViewsAbi, functionName: upper, isWord: false },
    { abi: upperViewsAsWordAbi, functionName: upper, isWord: true },
  ] as const;
  for (const attempt of attempts) {
    try {
      const value = await reader.readContract({ address: token, abi: attempt.abi, functionName: attempt.functionName });
      if (typeof value !== "string") continue;
      return attempt.isWord ? wordLength(value) : new TextEncoder().encode(value).length;
    } catch {
      continue;
    }
  }
  return 0;
};

/**
 * Reads the views of the mediator that decide the kind of the first message of a relay.
 * @param reader Reads views of the source chain.
 * @param input The mediator of the source chain and the token to relay.
 */
export async function readRelayGasFacts(reader: ContractReader, input: { mediator: Address; token: Address }): Promise<RelayGasFacts> {
  const native = await reader.readContract({ address: input.mediator, abi: tokenMediatorAbi, functionName: "nativeTokenAddress", args: [input.token] });
  if (String(native).toLowerCase() !== ZERO_ADDRESS) return { kind: "copy" };
  const acknowledged = await reader.readContract({
    address: input.mediator,
    abi: tokenMediatorAbi,
    functionName: "isBridgedTokenDeployAcknowledged",
    args: [input.token],
  });
  if (acknowledged === true) return { kind: "acknowledged" };
  const [nameBytes, symbolBytes] = await Promise.all([readTextBytes(reader, input.token, "name"), readTextBytes(reader, input.token, "symbol")]);
  return { kind: "unacknowledged", nameAndSymbolBytes: nameBytes + symbolBytes };
}

/**
 * The kind of the message that a relay sends, from the facts that {@link readRelayGasFacts} read.
 * @param facts What the mediator says about the token.
 * @param options Whether the relay calls the receiver.
 */
export function messageKindOfRelay(facts: RelayGasFacts, options: { withCall: boolean }): MessageKind {
  if (facts.kind === "unacknowledged") return { kind: "token-deploy", withCall: options.withCall, nameAndSymbolBytes: facts.nameAndSymbolBytes };
  return { kind: "token-release", withCall: options.withCall };
}

/**
 * Reads the kind of the message that a relay of a token sends. A relay of a copy, and a relay of a native token whose
 * copy the other chain proved, send a release. A relay of a native token with no proof yet sends a deploy. The check does
 * not use the address that the token factory predicts, because the copy can exist before the mediator records the proof,
 * and the mediator still sends a deploy then.
 * @param reader Reads views of the source chain.
 * @param input The mediator, the token, and whether the relay calls the receiver.
 */
export async function readRelayMessageKind(
  reader: ContractReader,
  input: { mediator: Address; token: Address; withCall: boolean },
): Promise<MessageKind> {
  return messageKindOfRelay(await readRelayGasFacts(reader, input), { withCall: input.withCall });
}
