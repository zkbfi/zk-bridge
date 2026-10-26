/**
 * Strict readers for the JSON that the indexer sends. Each reader names what it expected, so an error message tells the
 * reader which field of which answer was wrong. Amounts arrive as decimal strings and become `bigint` here, never `number`.
 */
import type { Address, Hex } from "viem";
import { getAddress } from "viem";

/** The indexer answered with something that this page cannot read. */
export class IndexerResponseError extends Error {
  override readonly name = "IndexerResponseError";
}

/** Reads an object. */
export const readRecord = (value: unknown, what: string): Record<string, unknown> => {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
  throw new IndexerResponseError(`The ${what} is not an object.`);
};

/** Reads a list. */
export const readArray = (value: unknown, what: string): unknown[] => {
  if (Array.isArray(value)) return value;
  throw new IndexerResponseError(`The ${what} is not a list.`);
};

/** Reads text. */
export const readText = (value: unknown, what: string): string => {
  if (typeof value === "string") return value;
  throw new IndexerResponseError(`The ${what} is not text.`);
};

/** Reads a safe integer, such as a block number or a timestamp. */
export const readInteger = (value: unknown, what: string): number => {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  throw new IndexerResponseError(`The ${what} is not an integer.`);
};

/** Reads a safe integer, or null when the value is not one. */
export const readNullableInteger = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) ? value : null;

/** Reads an amount. A JSON number is refused, because it may have lost digits. */
export const readAmount = (value: unknown, what: string): bigint => {
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  throw new IndexerResponseError(`The amount ${what} is not a decimal string.`);
};

/** Reads hex and lowercases it. */
export const readHex = (value: unknown, what: string): Hex => {
  if (typeof value === "string" && /^0x[0-9a-fA-F]*$/.test(value)) return value.toLowerCase() as Hex;
  throw new IndexerResponseError(`The ${what} is not hex.`);
};

/** Reads an address and returns it checksummed. */
export const readAddress = (value: unknown, what: string): Address => {
  if (typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value)) return getAddress(value);
  throw new IndexerResponseError(`The ${what} is not an address.`);
};
