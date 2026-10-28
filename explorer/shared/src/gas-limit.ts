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
