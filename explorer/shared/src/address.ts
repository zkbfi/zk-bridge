import { isAddress, type Address } from "viem";

/**
 * Lowercases an address.
 *
 * Ponder stores every address in lowercase and decodes event arguments in lowercase. A checksummed address from a
 * wallet or from viem never equals a stored address in SQL, so normalize once at every boundary.
 *
 * @param value A hex address in any letter case.
 * @throws When the value is not a 20 byte hex address.
 */
export const normalizeAddress = (value: string): Address => {
  if (!isAddress(value, { strict: false })) throw new Error(`not an address: ${value}`);
  return value.toLowerCase() as Address;
};

/**
 * Compares two addresses without regard to letter case.
 *
 * @param left The first address.
 * @param right The second address.
 */
export const sameAddress = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();

/** The zero address, in lowercase. */
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
