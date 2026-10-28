/**
 * The lines that a confirmation screen shows for the arguments of a call. One copy serves the terminal and the dapp.
 */
import { encodeAbiParameters, getAddress, isAddress, keccak256, type AbiParameter, type Hex } from "viem";

/** One line of the argument list of a call, as a confirmation screen shows it. */
export type DisplayedArgument = {
  readonly name: string;
  readonly type: string;
  /** The exact value: a checksummed address, a decimal integer, or hex. Long values are cut and carry a digest. */
  readonly value: string;
  /** A reading of the value for a person, such as the byte count. Absent when there is none. */
  readonly meaning?: string;
};

/** An array of more items than this is summarized by its length and the digest of its encoding. */
const MAXIMUM_ARRAY_ITEMS_SHOWN = 4;

/** A byte string longer than this is summarized by its length and its digest. */
const MAXIMUM_BYTES_SHOWN = 66;

/**
 * Describes a byte string: the whole value when it is short, otherwise its start and its digest.
 *
 * @param value The bytes as hex.
 * @returns The text to show and the byte count.
 */
export const describeBytes = (value: Hex): { value: string; meaning: string } => {
  const length = (value.length - 2) / 2;
  if (value.length <= MAXIMUM_BYTES_SHOWN) return { value, meaning: `${length} bytes` };
  return { value: `${value.slice(0, 34)}… keccak256 ${keccak256(value)}`, meaning: `${length} bytes` };
};

/**
 * Turns decoded values into display lines. Structures flatten to dotted names.
 *
 * An array of `bytes32` with at most four items shows whole, in any array form (`bytes32[]` or `bytes32[2]`). Any other
 * array shows its length and the digest of its encoding.
 *
 * @param parameters The ABI parameters, in order.
 * @param values The decoded values, in the same order.
 */
export const displayArguments = (
  parameters: readonly AbiParameter[],
  values: readonly unknown[],
): DisplayedArgument[] =>
  parameters.flatMap((parameter, index) => displayValue(parameter, values[index], parameter.name ?? `arg${index}`));

const displayValue = (parameter: AbiParameter, value: unknown, name: string): DisplayedArgument[] => {
  if (parameter.type === "tuple") return displayTuple(parameter, value, name);
  if (parameter.type.endsWith("]")) return [displayArray(parameter, value, name)];
  return [{ name, type: parameter.type, ...displayScalar(parameter.type, value) }];
};

const displayTuple = (parameter: AbiParameter, value: unknown, name: string): DisplayedArgument[] => {
  const components = (parameter as AbiParameter & { components: readonly AbiParameter[] }).components;
  const record = value as Record<string, unknown>;
  return components.flatMap((component, index) =>
    displayValue(component, record[component.name ?? String(index)], `${name}.${component.name ?? index}`),
  );
};

const displayArray = (parameter: AbiParameter, value: unknown, name: string): DisplayedArgument => {
  const items = value as readonly unknown[];
  const elementType = parameter.type.replace(/\[\d*\]$/, "");
  const summary = { name, type: parameter.type, meaning: `${items.length} items` };
  if (items.length === 0) return { ...summary, value: "[]" };
  if (items.length <= MAXIMUM_ARRAY_ITEMS_SHOWN && elementType === "bytes32") {
    return { ...summary, value: items.map(String).join(", ") };
  }
  return { ...summary, value: `keccak256 of the encoding ${keccak256(encodeAbiParameters([parameter], [value]))}` };
};

const displayScalar = (type: string, value: unknown): { value: string; meaning?: string } => {
  if (type === "address" && typeof value === "string" && isAddress(value, { strict: false })) {
    return { value: getAddress(value) };
  }
  if (type === "bytes" && typeof value === "string") return describeBytes(value as Hex);
  return { value: String(value) };
};
