import { decodeAbiParameters, encodeAbiParameters, isAddress, type Address, type Hex } from "viem";
import { sameAddress, ZERO_ADDRESS } from "./address.js";
import { RATE_SCALE } from "./format.js";

/**
 * The terms of a delivery: everything that the TypeScript side knows about the data of a relay to a `DeliveryRouter`.
 * This module is the one place that encodes, decodes, validates and prices those terms. It mirrors
 * `src/hardened/mediator/DeliveryRouter.sol` and, through it, the `FeeDirector` that carries the delivery terms. The terminal, the web page and the bots import from here and never read
 * or write a settings bit, a word of the data or a fee formula themselves.
 *
 * A gas based tip is computed from the gas that the delivery used up to the router callback (`startingGas` at router
 * entry minus `gasleft()` in the callback), plus the `callGas` of the director when a call is requested, plus a fixed
 * overhead, times the multiplier and the gas price. `limit` is the price ceiling that the sender signs. The follow-up call
 * gets exactly `callGas`: with too little gas the router callback reverts, and a call that fails with its gas leaves the
 * tokens with the recipient. The sender's `callbackGas` must cover the router's own work and the call: see
 * {@link routerCallbackGas}.
 *
 * The data of `onTokenBridged` is the 160 byte director (five words), then optionally a 20 byte target address, then the
 * call data (all remaining bytes, which may be empty). The legacy form is 20 bytes and cannot carry a call. Data of 161 to
 * 179 bytes makes the router deliver and make no call, because a tail shorter than a target is ignored. This module
 * refuses to build such data. Data shorter than 160 bytes (and not exactly 20) has no known shape.
 *
 * The test `test/delivery-terms.test.ts` checks the constants, the encoding and the fee against vectors that the compiled
 * router printed (`vectors/GenerateDeliveryFeeVectors.s.sol`), so the two sides cannot drift.
 *
 * All amounts are bigint. A rate or a multiplier is scaled by `RATE_SCALE` (1e18).
 */

/** The value of `settings` bit 0 (`DeliveryRouter.FIXED_FEE`): the tip is `limit`. */
export const FIXED_FEE = 1n;
/** The value of `settings` bit 1 (`DeliveryRouter.UNWRAP`): unwrap the wrapped native token to the native coin. It applies to the wrapped native token only. */
export const UNWRAP = 2n;
/** The value of `settings` bit 2 (`DeliveryRouter.EXCLUDE_PRIORITY`): price gas at the base fee only, with no priority fee. */
export const EXCLUDE_PRIORITY = 4n;
/** The value of `settings` bit 3 (`DeliveryRouter.MULTIPLIER_OF_TOTAL`): the tip is `value * multiplier / 1e18`. */
export const MULTIPLIER_OF_TOTAL = 8n;

/** Gas that the router adds to the measured gas of a token payout. Same as `DeliveryRouter.TOKEN_GAS_OVERHEAD`. */
export const TOKEN_GAS_OVERHEAD = 100_000n;
/**
 * Gas that the router adds to the measured gas of a native coin payout. Same as `DeliveryRouter.NATIVE_GAS_OVERHEAD`
 * (105,000 since the router that emits `Delivered`; the routers before it add 100,000, so an estimate for them is 5,000
 * gas high, never low).
 */
export const NATIVE_GAS_OVERHEAD = 105_000n;

/** The name of each settings flag, as the contract names it. */
export type SettingFlagName = "FIXED_FEE" | "UNWRAP" | "EXCLUDE_PRIORITY" | "MULTIPLIER_OF_TOTAL";

/** The value of each settings flag, by the name that the contract gives it. */
export const SETTING_FLAG_VALUES: Readonly<Record<SettingFlagName, bigint>> = {
  FIXED_FEE,
  UNWRAP,
  EXCLUDE_PRIORITY,
  MULTIPLIER_OF_TOTAL,
};

/** Every settings bit that the router reads. A higher bit has no effect. */
export const KNOWN_SETTING_BITS = FIXED_FEE | UNWRAP | EXCLUDE_PRIORITY | MULTIPLIER_OF_TOTAL;

/** The largest value of a `uint256`. */
export const UINT256_MAXIMUM = 2n ** 256n - 1n;

/** Gas that the router keeps back from a call after a delivery. Same as `DeliveryRouter.CALL_GAS_RESERVE`. */
export const CALL_GAS_RESERVE = 10_000n;

/**
 * The gas that the router's own work in `onTokenBridged` needs: the tip and the payout, worst case a native payout with
 * the fallbacks. A frontend that relays to a router passes {@link routerCallbackGas} as the `callbackGas`. The forge
 * test `test_theCoreCallbackGasBaseCoversTheCostliestPathOfTheRouter` checks that this number is enough: that path needs
 * about 100,000 gas of router work with a plain token, and the rest is room for tokens whose transfers cost more.
 */
export const ROUTER_CALLBACK_GAS_BASE = 300_000n;

/**
 * The most gas that a follow-up call of a delivery may get. A delivery runs in one transaction on the destination chain,
 * so the call gas, the callback gas around it and the proof must fit one block, and on Sepolia one transaction may use at
 * most 16,777,216 gas (EIP-7825). Ten million leaves room for the rest of the delivery. The encoder, the guard of the
 * terms and {@link routerCallbackGas} refuse more, and every form and link reads this one number.
 */
export const MAX_CALL_GAS = 10_000_000n;

const callGasAboveCapText = `The call gas is above ${MAX_CALL_GAS}, the most that a delivery can carry.`;

/** The bytes of the legacy form: one address. */
export const LEGACY_RECEIVER_BYTES = 20;
/** The size of an encoded director: five words. */
export const FEE_DIRECTOR_BYTES = 160;
/** The bytes of the target address that follows a director. */
export const DELIVERY_CALL_TARGET_BYTES = 20;
/** Where the call data starts: the director plus the target. Data shorter than this makes no call. */
export const DELIVERY_CALL_OFFSET_BYTES = FEE_DIRECTOR_BYTES + DELIVERY_CALL_TARGET_BYTES;

/** The call that the router makes after a delivery: from the router, with no native value. */
export interface DeliveryCall {
  /** The contract that the router calls. */
  readonly target: Address;
  /** The call data. It may be empty (`0x`). */
  readonly data: Hex;
}

/** The `FeeDirector` struct of `DeliveryRouter.sol`. */
export interface FeeDirector {
  /** Who receives the tokens after the tip. */
  readonly recipient: Address;
  /** Flag bits: see {@link SETTING_FLAG_VALUES}. */
  readonly settings: bigint;
  /**
   * The fixed tip, or the price ceiling of the gas based tip, in base units of the transferred token. The gas based tip is
   * computed from the gas that the delivery used up to the router callback, plus the call gas when a call is requested,
   * plus the overhead. `limit` is the hard ceiling that the sender signs.
   */
  readonly limit: bigint;
  /** Scaled by 1e18: the share of the value, or the factor on the gas cost. */
  readonly multiplier: bigint;
  /**
   * The exact gas that the follow-up call gets. It must be above zero when the data carries a call, and it is ignored (use
   * 0n) when it does not. The router counts it in a gas based tip when a call is requested.
   */
  readonly callGas: bigint;
}

/** How the router computes the tip. `fixed` wins over `share`, as in the router. */
export type FeeMode = "fixed" | "share" | "gas";

/** How the payout travels. `native` needs the `UNWRAP` flag and the wrapped native token. */
export type PayoutKind = "token" | "native";

/** Which gas price a gas based tip uses. */
export type GasPriceBasis = "transaction" | "base-fee-only";

/** What {@link settingsOf} needs to build the flag bits. */
export interface SettingsChoice {
  readonly mode: FeeMode;
  /** Default: `token`. `native` sets `UNWRAP`. */
  readonly payout?: PayoutKind;
  /** Default: `transaction`. `base-fee-only` sets `EXCLUDE_PRIORITY`, and only a gas based tip reads it. */
  readonly gasPrice?: GasPriceBasis;
}

/**
 * Builds the flag bits of a director, so that no caller sets a bit itself.
 *
 * @param choice The fee mode, the payout and the gas price basis.
 */
export const settingsOf = (choice: SettingsChoice): bigint => {
  const modeBits: Readonly<Record<FeeMode, bigint>> = { fixed: FIXED_FEE, share: MULTIPLIER_OF_TOTAL, gas: 0n };
  const payoutBits = choice.payout === "native" ? UNWRAP : 0n;
  const gasBits = choice.mode === "gas" && choice.gasPrice === "base-fee-only" ? EXCLUDE_PRIORITY : 0n;
  return modeBits[choice.mode] | payoutBits | gasBits;
};

/**
 * Tells how the router computes the tip of a director. `FIXED_FEE` wins over `MULTIPLIER_OF_TOTAL`.
 *
 * @param settings The flag bits.
 */
export const feeModeOf = (settings: bigint): FeeMode => {
  if ((settings & FIXED_FEE) !== 0n) return "fixed";
  if ((settings & MULTIPLIER_OF_TOTAL) !== 0n) return "share";
  return "gas";
};

/**
 * Lists the flags that the settings set, in bit order.
 *
 * @param settings The flag bits.
 */
export const settingFlagsOf = (settings: bigint): readonly SettingFlagName[] =>
  (Object.keys(SETTING_FLAG_VALUES) as SettingFlagName[]).filter((name) => (settings & SETTING_FLAG_VALUES[name]) !== 0n);

/**
 * The payout that the sender asks for in the settings. It is a request: the router pays the native coin only when the
 * token is the wrapped native token, and {@link assertValidFeeTerms} refuses the request for any other token.
 *
 * @param settings The flag bits.
 */
export const requestedPayoutOf = (settings: bigint): PayoutKind => ((settings & UNWRAP) !== 0n ? "native" : "token");

/**
 * The gas price basis that the settings ask for.
 *
 * @param settings The flag bits.
 */
export const gasPriceBasisOf = (settings: bigint): GasPriceBasis => ((settings & EXCLUDE_PRIORITY) !== 0n ? "base-fee-only" : "transaction");

const OVERHEAD_OF: Readonly<Record<PayoutKind, bigint>> = { token: TOKEN_GAS_OVERHEAD, native: NATIVE_GAS_OVERHEAD };

/**
 * The gas that the router adds to the measured gas for a payout.
 *
 * @param payout How the payout travels.
 */
export const gasOverheadOf = (payout: PayoutKind): bigint => OVERHEAD_OF[payout];

const DIRECTOR_PARAMETERS = [
  { type: "address", name: "recipient" },
  { type: "uint256", name: "settings" },
  { type: "uint256", name: "limit" },
  { type: "uint256", name: "multiplier" },
  { type: "uint256", name: "callGas" },
] as const;

/** An address that no tip recipient may be, with the words that name it in the message. */
export interface ProtectedAddress {
  readonly label: string;
  readonly address: Address;
}

/** Whether a chain reports a base fee in `block.basefee`. */
export type BaseFeeSupport = "reported" | "none";

/** What the guard needs to know about the router and its deployment. */
export interface FeeTermsContext {
  /** The router that receives the relay. */
  readonly router: Address;
  /** The addresses that a recipient must not be: the delivery routers, the mediators and the bridges of the deployment. */
  readonly protectedAddresses: readonly ProtectedAddress[];
  /** The token that the router receives, on the destination chain. Null when unknown. */
  readonly destinationToken: Address | null;
  /** The wrapped native token of the destination chain. Null when the deployment names none. */
  readonly destinationWrappedNative: Address | null;
  /**
   * Whether the destination chain reports a base fee. `none` for a chain whose `block.basefee` is 0 (BSC): there
   * `EXCLUDE_PRIORITY` gives a gas tip of zero. Default: `reported`.
   */
  readonly destinationBaseFee?: BaseFeeSupport;
}

/** The data of a relay to a router, with the facts that the legacy form and the unwrap flag depend on. */
export interface FeeTermsInput extends FeeTermsContext {
  /** The callback data of the relay. */
  readonly data: Hex;
}

/** A named failure of the guard. The message tells the user what to fix. */
export class FeeTermsError extends Error {
  override readonly name = "FeeTermsError";
}

/** One chain of a deployment, as far as the guard needs it. */
export interface ProtectedChain {
  readonly name: string;
  readonly bridge: Address;
  readonly mediator: Address;
  readonly deliveryRouter: Address | null;
}

/**
 * Lists the addresses that a recipient must never be: for each chain the delivery router, the mediator and the bridge.
 *
 * @param chains The chains of the deployment, both sides of the pair.
 */
export const protectedAddressesOf = (chains: readonly ProtectedChain[]): readonly ProtectedAddress[] =>
  chains.flatMap((chain) => [
    ...(chain.deliveryRouter === null ? [] : [{ label: `the delivery router of ${chain.name}`, address: chain.deliveryRouter }]),
    { label: `the mediator of ${chain.name}`, address: chain.mediator },
    { label: `the bridge of ${chain.name}`, address: chain.bridge },
  ]);

/**
 * True when the address is one of the delivery routers in the list. The terminal and the web page use it to decide that a
 * receiver is a router, so a hand written relay to a router gets the same check as a delivery tip.
 *
 * The list is a frontend and operator allowlist, not a protocol rule: the mediator and the bridge name no router, and any
 * contract can receive a relay. A frontend may point to any router it trusts and swap it at will.
 *
 * @param address Any address.
 * @param chains The chains of the deployment.
 */
export const isKnownDeliveryRouter = (address: Address, chains: readonly ProtectedChain[]): boolean =>
  chains.some((chain) => chain.deliveryRouter !== null && sameAddress(chain.deliveryRouter, address));

const bytesOf = (data: Hex): number => (data.length - 2) / 2;

const isWrappedNativeToken = (context: FeeTermsContext): boolean =>
  context.destinationToken !== null &&
  context.destinationWrappedNative !== null &&
  sameAddress(context.destinationToken, context.destinationWrappedNative);

/** True when the first word of a director has bits above 160. `abi.decode` of the router reverts on such a word. */
const hasDirtyRecipientWord = (data: Hex): boolean => !/^0{24}/.test(data.slice(2, 66));

const recipientOf = (data: Hex, length: number): Address => {
  if (length === LEGACY_RECEIVER_BYTES) return data.toLowerCase() as Address;
  if (hasDirtyRecipientWord(data)) throw new FeeTermsError("The recipient word of the fee terms has bits above 160. The router would refuse it.");
  return `0x${data.slice(26, 66)}` as Address;
};

const settingsOfData = (data: Hex): bigint => BigInt(`0x${data.slice(66, 130)}`);

/** The fifth word of a director: the gas of the follow-up call. */
const callGasOfData = (data: Hex): bigint => BigInt(`0x${data.slice(258, 322)}`);

/**
 * Refuses terms that the router would hand to its failed delivery address, a legacy shape that has no native coin to
 * unwrap, an `UNWRAP` request for a token that is not the wrapped native token, and settings bits that the router does
 * not read. The contract keeps its behaviour on purpose (it never reverts and never burns). So every interface must
 * refuse to build such a transfer, and this is the one place that decides.
 *
 * @param input The router, the data, the token and the protected addresses.
 * @throws FeeTermsError with a sentence for the user.
 */
export const assertValidFeeTerms = (input: FeeTermsInput): void => {
  const { data, router } = input;
  if (!isAddress(router, { strict: false })) throw new FeeTermsError("The router is not an address.");
  if (!/^0x([0-9a-fA-F]{2})*$/.test(data)) throw new FeeTermsError("The call data to a delivery router must be hex with an even number of digits.");
  const length = bytesOf(data);
  if (length !== LEGACY_RECEIVER_BYTES && length < FEE_DIRECTOR_BYTES) {
    throw new FeeTermsError(
      `The call data to a delivery router must be the ${FEE_DIRECTOR_BYTES} byte fee terms, not ${length} bytes. The router hands other data to its failed delivery address.`,
    );
  }
  if (length > FEE_DIRECTOR_BYTES && length < DELIVERY_CALL_OFFSET_BYTES) {
    throw new FeeTermsError(
      `The call data has ${length} bytes, which is more than the ${FEE_DIRECTOR_BYTES} byte fee terms and less than ${DELIVERY_CALL_OFFSET_BYTES} bytes. A call needs a ${DELIVERY_CALL_TARGET_BYTES} byte target after the fee terms, so the router would make no call. Add the target or remove the extra bytes.`,
    );
  }
  if (length === LEGACY_RECEIVER_BYTES) assertLegacyToken(input);
  if (length >= FEE_DIRECTOR_BYTES) assertSettings(settingsOfData(data), input);
  if (length >= FEE_DIRECTOR_BYTES && callGasOfData(data) > MAX_CALL_GAS) throw new FeeTermsError(callGasAboveCapText);
  const recipient = recipientOf(data, length);
  if (sameAddress(recipient, ZERO_ADDRESS)) throw new FeeTermsError("The recipient of the fee terms is the zero address. The router would hand the value to its failed delivery address.");
  if (sameAddress(recipient, router)) throw new FeeTermsError("The recipient of the fee terms is the router itself. The router would hand the value to its failed delivery address.");
  const clash = input.protectedAddresses.find((protectedAddress) => sameAddress(protectedAddress.address, recipient));
  if (clash !== undefined) throw new FeeTermsError(`The recipient of the fee terms is ${clash.label}. Tokens sent there are lost to you. Name your own account.`);
  assertCallTarget(input);
};

const assertCallTarget = (input: FeeTermsInput): void => {
  const call = decodeDeliveryCall(input.data);
  if (call === null) return;
  if (sameAddress(call.target, ZERO_ADDRESS)) throw new FeeTermsError("The target of the call is the zero address. The router would call nothing useful. Name a contract.");
  if (sameAddress(call.target, input.router)) throw new FeeTermsError("The target of the call is the router itself. Name another contract.");
  const clash = input.protectedAddresses.find((protectedAddress) => sameAddress(protectedAddress.address, call.target));
  if (clash !== undefined) throw new FeeTermsError(`The target of the call is ${clash.label}. The router must not call it. Name another contract.`);
  if (callGasOfData(input.data) === 0n) throw new FeeTermsError("The call has no gas. Set the call gas above zero: the router gives the call exactly that much.");
};

const assertLegacyToken = (input: FeeTermsInput): void => {
  if (isWrappedNativeToken(input)) return;
  throw new FeeTermsError(`The 20 byte call data pays the native coin, so it works only for the wrapped native token. Use the ${FEE_DIRECTOR_BYTES} byte fee terms for this token.`);
};

const assertSettings = (settings: bigint, input: FeeTermsInput): void => {
  if ((settings & ~KNOWN_SETTING_BITS) !== 0n) {
    throw new FeeTermsError("The settings of the fee terms set bits that the router does not read. Clear them.");
  }
  if ((settings & EXCLUDE_PRIORITY) !== 0n && input.destinationBaseFee === "none") {
    throw new FeeTermsError("The fee terms price gas at the base fee only, but this chain reports no base fee. The gas tip would be zero. Clear that flag.");
  }
  if ((settings & UNWRAP) !== 0n && !isWrappedNativeToken(input)) {
    throw new FeeTermsError("The fee terms ask to unwrap, but unwrapping works only for the wrapped native token. The router would pay the plain token. Clear the unwrap flag.");
  }
};

/**
 * Encodes a director as `abi.encode(director)` does. The struct is static, so the result is five words with no offset.
 * This is the callback data of `relayTokensAndCall`. It runs the guard, so no caller can skip it.
 *
 * @param director The director.
 * With a call, the four words are followed by the 20 byte target and the call data, as `abi.encodePacked(abi.encode(director),
 * target, callData)` does.
 *
 * @param director The director.
 * @param context The router that receives the relay, the token, and the addresses that a recipient must not be.
 * @param call The call that the router makes after the delivery. Omit it for a delivery only.
 * @throws FeeTermsError when the router would not honour the terms.
 */
export const encodeFeeDirector = (director: FeeDirector, context: FeeTermsContext, call?: DeliveryCall): Hex => {
  const words = encodeAbiParameters(DIRECTOR_PARAMETERS, [director.recipient, director.settings, director.limit, director.multiplier, director.callGas]);
  const data: Hex = call === undefined ? words : `${words}${call.target.slice(2).toLowerCase()}${call.data.slice(2).toLowerCase()}`;
  assertValidFeeTerms({ ...context, data });
  return data;
};

/**
 * Decodes `abi.decode(data, (FeeDirector))`. The router reads the first 160 bytes and ignores the rest, and so does this.
 *
 * @param data At least 160 bytes.
 * @throws When the data is shorter than 160 bytes, or when the address word has bits above 160.
 */
export const decodeFeeDirector = (data: Hex): FeeDirector => {
  const bytes = bytesOf(data);
  if (bytes < FEE_DIRECTOR_BYTES) throw new RangeError(`a fee director is at least ${FEE_DIRECTOR_BYTES} bytes, not ${bytes}`);
  if (hasDirtyRecipientWord(data)) throw new RangeError("the recipient word of a fee director has bits above 160");
  const [recipient, settings, limit, multiplier, callGas] = decodeAbiParameters(DIRECTOR_PARAMETERS, data.slice(0, 2 + FEE_DIRECTOR_BYTES * 2) as Hex);
  return { recipient, settings, limit, multiplier, callGas };
};

/**
 * Reads the call after the director, as the router does: data of 180 bytes or more names a target (20 bytes after the
 * director) and the call data (all bytes after the target, possibly empty). Shorter data makes no call.
 *
 * @param data The callback data of a transfer.
 * @returns The call, or null when the router makes none.
 */
export const decodeDeliveryCall = (data: Hex): DeliveryCall | null => {
  if (bytesOf(data) < DELIVERY_CALL_OFFSET_BYTES) return null;
  const targetStart = 2 + FEE_DIRECTOR_BYTES * 2;
  const callStart = 2 + DELIVERY_CALL_OFFSET_BYTES * 2;
  return { target: `0x${data.slice(targetStart, callStart)}` as Address, data: `0x${data.slice(callStart)}` };
};

/** What the router reads from the data of `onTokenBridged`, as the router decides it. */
export type DeliveryTerms =
  | { readonly kind: "legacy"; readonly receiver: Address }
  | { readonly kind: "director"; readonly director: FeeDirector; readonly call: DeliveryCall | null }
  | { readonly kind: "unknown"; readonly bytes: number };

/**
 * Reads the callback data as the router does: 20 bytes are the legacy receiver (no tip), 160 bytes or more are a
 * director (with a call when the data has 180 bytes or more, and no call for 161 to 179 bytes), and anything else has
 * no known shape (the router hands the whole value to its failed delivery address). A director whose address word has
 * bits above 160 also has no known shape here.
 *
 * @param data The callback data of a transfer.
 */
export const readDeliveryTerms = (data: Hex): DeliveryTerms => {
  const bytes = bytesOf(data);
  if (bytes === LEGACY_RECEIVER_BYTES) return { kind: "legacy", receiver: data.toLowerCase() as Address };
  if (bytes < FEE_DIRECTOR_BYTES) return { kind: "unknown", bytes };
  try {
    return { kind: "director", director: decodeFeeDirector(data), call: decodeDeliveryCall(data) };
  } catch {
    return { kind: "unknown", bytes };
  }
};

/**
 * The gas price basis that the default gas based tip uses on a destination chain. A chain that reports a base fee gets
 * `base-fee-only` (the router flag `EXCLUDE_PRIORITY`). A chain with no base fee (`block.basefee` is 0) gets
 * `transaction`, the whole gas price, because the base fee flag would make the tip zero.
 *
 * @param support Whether the destination chain reports a base fee. Default: `reported`.
 */
export const gasPriceBasisFor = (support: BaseFeeSupport | undefined): GasPriceBasis => (support === "none" ? "transaction" : "base-fee-only");

/**
 * The payout that the router makes: native only when the settings ask for it and the token is the wrapped native token.
 *
 * @param settings The flag bits.
 * @param tokenIsWrappedNative True when the token is the wrapped native token of the chain.
 */
export const payoutOf = (settings: bigint, tokenIsWrappedNative: boolean): PayoutKind =>
  tokenIsWrappedNative && requestedPayoutOf(settings) === "native" ? "native" : "token";

const divideRoundingUp = (numerator: bigint, denominator: bigint): bigint => (numerator + denominator - 1n) / denominator;

/**
 * Divides and rounds up, for the callers that suggest a fee and must never promise less than the cost.
 *
 * @param numerator The dividend.
 * @param denominator The divisor, above zero.
 */
export const ceilingDivide = divideRoundingUp;

/** Multiplies like checked Solidity arithmetic: the router reverts when a product passes 256 bits. */
const checkedProduct = (...factors: readonly bigint[]): bigint => {
  let product = 1n;
  for (const factor of factors) {
    product *= factor;
    if (product > UINT256_MAXIMUM) throw new RangeError("the fee arithmetic overflows 256 bits, so the router would revert");
  }
  return product;
};

/** Adds like checked Solidity arithmetic. */
const checkedSum = (left: bigint, right: bigint): bigint => {
  const sum = left + right;
  if (sum > UINT256_MAXIMUM) throw new RangeError("the fee arithmetic overflows 256 bits, so the router would revert");
  return sum;
};

/** Input of {@link expectedFee}. */
export interface ExpectedFeeInput {
  /** The amount that the mediator releases to the router, in base units. */
  readonly value: bigint;
  /** The gas that the router measures, for a gas based fee. It does not matter for a fixed or share fee. */
  readonly gasUsed: bigint;
  /** The base fee of the destination chain, in wei per gas. */
  readonly baseFeeWei: bigint;
  /** The priority fee, in wei per gas. The transaction gas price is the base fee plus this. Default: zero. */
  readonly priorityFeeWei?: bigint;
  /** `native` when the token is the wrapped native token and the unwrap flag is set. Default: `token`. */
  readonly payout?: PayoutKind;
}

/** The split that `DeliveryRouter.feeInfo` returns. */
export interface FeeSplit {
  readonly fee: bigint;
  readonly toRecipient: bigint;
}

const clampToValue = (fee: bigint, value: bigint): bigint => (fee > value ? value : fee);

const rawFee = (director: FeeDirector, input: ExpectedFeeInput): bigint => {
  const mode = feeModeOf(director.settings);
  if (mode === "fixed") return director.limit;
  if (mode === "share") return checkedProduct(input.value, director.multiplier) / RATE_SCALE;
  const priorityFeeWei = gasPriceBasisOf(director.settings) === "base-fee-only" ? 0n : (input.priorityFeeWei ?? 0n);
  const overhead = gasOverheadOf(input.payout ?? "token");
  const uncapped = checkedProduct(checkedSum(input.gasUsed, overhead), director.multiplier, checkedSum(input.baseFeeWei, priorityFeeWei)) / RATE_SCALE;
  return uncapped > director.limit ? director.limit : uncapped;
};

/**
 * The tip that the router takes, as `DeliveryRouter.feeInfo` computes it. Fixed: `limit`. Share: `value * multiplier / 1e18`.
 * Gas based: `(gasUsed + overhead) * multiplier * gasPrice / 1e18`, capped by `limit`. The tip never passes the value.
 *
 * The router measures the gas in the callback, so `gasUsed` is the gas that it reads there.
 *
 * @param director The fee terms.
 * @param input The value, the gas and the prices.
 * @throws When the router would revert on an overflow of 256 bits.
 */
export const expectedFee = (director: FeeDirector, input: ExpectedFeeInput): FeeSplit => {
  const fee = clampToValue(rawFee(director, input), input.value);
  return { fee, toRecipient: input.value - fee };
};

/**
 * The most that the reward address can take for a director from a transfer of `value`: the tip with no gas figure counted
 * for a fixed or share fee, and the cap for a gas based fee. In all cases it is no more than the value.
 *
 * @param director The fee terms.
 * @param value The amount that the mediator releases, in base units.
 * @throws When a share fee would overflow 256 bits.
 */
export const maximumFee = (director: FeeDirector, value: bigint): bigint => {
  const mode = feeModeOf(director.settings);
  if (mode === "gas") return clampToValue(director.limit, value);
  return expectedFee(director, { value, gasUsed: 0n, baseFeeWei: 0n }).fee;
};

/**
 * The `callbackGas` that a frontend passes to `relayTokensAndCall` when the receiver is a delivery router: the router's
 * own work, plus, when a call is requested, the call gas, one 64th of it that the 63/64 rule holds back, and the reserve.
 *
 * @param input The call gas of the director. Omit it, or give zero, for a delivery with no call.
 */
export const routerCallbackGas = (input: { callGas?: bigint }): bigint => {
  const callGas = input.callGas;
  if (callGas === undefined || callGas <= 0n) return ROUTER_CALLBACK_GAS_BASE;
  if (callGas > MAX_CALL_GAS) throw new RangeError(callGasAboveCapText);
  return ROUTER_CALLBACK_GAS_BASE + callGas + divideRoundingUp(callGas, 63n) + CALL_GAS_RESERVE;
};

/**
 * The most callback gas that a relay may state: what a router needs for a call of {@link MAX_CALL_GAS}. A form refuses
 * more for any receiver, because no delivery could carry it.
 */
export const MAX_CALLBACK_GAS = routerCallbackGas({ callGas: MAX_CALL_GAS });

/** Input of {@link worstCaseFee}. */
export interface WorstCaseFeeInput {
  /** The amount that the mediator releases to the router, in base units. */
  readonly value: bigint;
  /** The frontend's estimate of the gas that the delivery uses before the router callback (proof, bridge and mediator). */
  readonly deliveryGas: bigint;
  /** The gas price of the destination chain, in wei per gas. */
  readonly gasPrice: bigint;
  /** How the payout travels. */
  readonly payout: PayoutKind;
  /** True when the director asks for a follow-up call, so its `callGas` counts. */
  readonly withCall: boolean;
}

/**
 * The most that a delivery tip is expected to be: the "max" that the app shows. `limit` stays the signed hard ceiling
 * (see {@link maximumFee}). Fixed: `min(limit, value)`. Share: `min(value * multiplier / 1e18, value)`. Gas based:
 * `min(limit, value, (deliveryGas + callGas + overhead) * multiplier * gasPrice / 1e18)`.
 *
 * @param director The fee terms.
 * @param input The value, the gas estimate, the gas price, the payout and whether a call is requested.
 * @throws When the arithmetic would overflow 256 bits.
 */
export const worstCaseFee = (director: FeeDirector, input: WorstCaseFeeInput): bigint => {
  const mode = feeModeOf(director.settings);
  if (mode === "fixed") return clampToValue(director.limit, input.value);
  if (mode === "share") return clampToValue(checkedProduct(input.value, director.multiplier) / RATE_SCALE, input.value);
  const gas = checkedSum(checkedSum(input.deliveryGas, input.withCall ? director.callGas : 0n), gasOverheadOf(input.payout));
  const estimate = checkedProduct(gas, director.multiplier, input.gasPrice) / RATE_SCALE;
  return clampToValue(estimate > director.limit ? director.limit : estimate, input.value);
};
