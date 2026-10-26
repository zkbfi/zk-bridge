import { isAddress, type Address, type Hex } from "viem";
import { sameAddress, ZERO_ADDRESS } from "./address.js";

/**
 * The guard for the data of a relay to a `DeliveryRouter`.
 *
 * The router hands the value to its failed delivery address when the terms are invalid: a recipient that is the zero
 * address or the router itself (after the tip, when the delivery pays one), or data that is neither 20 bytes nor at
 * least 128 bytes (the whole value). The contract keeps that behaviour on purpose. So every interface must refuse to build such a transfer. This module is the one place that
 * decides, and `encodeFeeDirector` calls it, so no caller can skip it.
 */

/** The bytes of the legacy form: one address. */
export const LEGACY_RECEIVER_BYTES = 20;
/** The bytes of an encoded director: four words. */
export const DIRECTOR_DATA_BYTES = 128;

/** An address that no fee recipient may be, with the words that name it in the message. */
export interface ProtectedAddress {
  readonly label: string;
  readonly address: Address;
}

/** What the guard needs to know about the router and its deployment. */
export interface FeeTermsContext {
  /** The router that receives the relay. */
  readonly router: Address;
  /** The addresses that a recipient must not be: the delivery routers, the mediators and the bridges of the deployment. */
  readonly protectedAddresses: readonly ProtectedAddress[];
}

/** The data of a relay to a router, with the facts that the legacy form depends on. */
export interface FeeTermsInput extends FeeTermsContext {
  /** The callback data of the relay. */
  readonly data: Hex;
  /** The token that the router receives, on the destination chain. Null when unknown. */
  readonly destinationToken: Address | null;
  /** The wrapped native token of the destination chain. Null when the deployment names none. */
  readonly destinationWrappedNative: Address | null;
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
 * Lists the addresses that a fee recipient must never be: for each chain the delivery router, the mediator and the bridge.
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
 * receiver is a router, so a hand written relay to a router gets the same check as a delivery fee.
 *
 * @param address Any address.
 * @param chains The chains of the deployment.
 */
export const isKnownDeliveryRouter = (address: Address, chains: readonly ProtectedChain[]): boolean =>
  chains.some((chain) => chain.deliveryRouter !== null && sameAddress(chain.deliveryRouter, address));

const bytesOf = (data: Hex): number => (data.length - 2) / 2;

const recipientOf = (data: Hex, length: number): Address => {
  if (length === LEGACY_RECEIVER_BYTES) return data.toLowerCase() as Address;
  const word = data.slice(2, 66);
  if (!/^0{24}/.test(word)) throw new FeeTermsError("The recipient word of the fee terms has bits above 160. The router would refuse it.");
  return `0x${word.slice(24)}` as Address;
};

/**
 * Refuses data that the router would hand to its failed delivery address, and the one legacy shape that has no native coin to unwrap.
 *
 * @param input The router, the data, the token and the protected addresses.
 * @throws FeeTermsError with a sentence for the user.
 */
export const assertValidFeeTerms = (input: FeeTermsInput): void => {
  const { data, router } = input;
  if (!isAddress(router, { strict: false })) throw new FeeTermsError("The router is not an address.");
  if (!/^0x([0-9a-fA-F]{2})*$/.test(data)) throw new FeeTermsError("The call data to a delivery router must be hex with an even number of digits.");
  const length = bytesOf(data);
  if (length !== LEGACY_RECEIVER_BYTES && length !== DIRECTOR_DATA_BYTES) {
    throw new FeeTermsError(
      `The call data to a delivery router must be the ${DIRECTOR_DATA_BYTES} byte fee terms, not ${length} bytes. The router hands other data to its failed delivery address.`,
    );
  }
  if (length === LEGACY_RECEIVER_BYTES) assertLegacyToken(input);
  const recipient = recipientOf(data, length);
  if (sameAddress(recipient, ZERO_ADDRESS)) throw new FeeTermsError("The recipient of the fee terms is the zero address. The router would hand the value to its failed delivery address.");
  if (sameAddress(recipient, router)) throw new FeeTermsError("The recipient of the fee terms is the router itself. The router would hand the value to its failed delivery address.");
  const clash = input.protectedAddresses.find((protectedAddress) => sameAddress(protectedAddress.address, recipient));
  if (clash !== undefined) throw new FeeTermsError(`The recipient of the fee terms is ${clash.label}. Tokens sent there are lost to you. Name your own account.`);
};

const assertLegacyToken = (input: FeeTermsInput): void => {
  const { destinationToken, destinationWrappedNative } = input;
  if (destinationToken !== null && destinationWrappedNative !== null && sameAddress(destinationToken, destinationWrappedNative)) return;
  throw new FeeTermsError("The 20 byte call data pays the native coin, so it works only for the wrapped native token. Use the 128 byte fee terms for this token.");
};
