/**
 * Decoding of calldata into the lines that the confirmation screen shows.
 */
import {
  decodeFunctionData,
  toFunctionSignature,
  getAddress,
  isAddress,
  keccak256,
  encodeAbiParameters,
  toFunctionSelector,
  type Abi,
  type AbiFunction,
  type AbiParameter,
  type Hex,
} from 'viem'
import { knownAbis } from './abis'
import type { DisplayArgument } from './plan'

/** The decoded form of calldata that a known ABI matched. */
export interface DecodedCall {
  readonly functionName: string
  readonly functionSignature: string
  readonly arguments: readonly DisplayArgument[]
}

/** An array of more items than this is summarized by its length and the digest of its encoding. */
const MAXIMUM_ARRAY_ITEMS_SHOWN = 4

/** A byte string longer than this is summarized by its length and its digest. */
const MAXIMUM_BYTES_SHOWN = 66

/**
 * Decodes calldata with the first known ABI that has the function.
 *
 * @returns The decoded call, or `null` when no known ABI matches the selector or the arguments do not decode.
 */
export function decodeKnownCall(data: Hex, abis: readonly Abi[] = knownAbis): DecodedCall | null {
  for (const abi of abis) {
    const decoded = tryDecode(abi, data)
    if (decoded !== null) return decoded
  }
  return null
}

/** Names the function behind a four-byte selector, or `null` when no known ABI has it. */
export function functionSignatureOfSelector(selector: Hex, abis: readonly Abi[] = knownAbis): string | null {
  for (const abi of abis) {
    const item = abi.find((entry): entry is AbiFunction => entry.type === 'function' && toFunctionSelector(entry) === selector)
    if (item !== undefined) return toFunctionSignature(item)
  }
  return null
}

/** The selector of calldata: the first four bytes, or `null` for shorter data. */
export function selectorOf(data: Hex): Hex | null {
  return data.length >= 10 ? (data.slice(0, 10) as Hex) : null
}

/** Turns decoded values into display lines. Structures flatten to dotted names. */
export function displayArguments(parameters: readonly AbiParameter[], values: readonly unknown[]): DisplayArgument[] {
  return parameters.flatMap((parameter, index) => displayValue(parameter, values[index], parameter.name ?? `arg${index}`))
}

function tryDecode(abi: Abi, data: Hex): DecodedCall | null {
  const selector = selectorOf(data)
  if (selector === null) return null
  const item = abi.find((entry): entry is AbiFunction => entry.type === 'function' && toFunctionSelector(entry) === selector)
  if (item === undefined) return null
  try {
    const decoded = decodeFunctionData({ abi, data })
    return {
      functionName: item.name,
      functionSignature: toFunctionSignature(item),
      arguments: displayArguments(item.inputs, decoded.args ?? []),
    }
  } catch {
    return null
  }
}

function displayValue(parameter: AbiParameter, value: unknown, name: string): DisplayArgument[] {
  if (parameter.type === 'tuple') return displayTuple(parameter, value, name)
  if (parameter.type.endsWith(']')) return [displayArray(parameter, value, name)]
  return [{ name, type: parameter.type, ...displayScalar(parameter.type, value) }]
}

function displayTuple(parameter: AbiParameter, value: unknown, name: string): DisplayArgument[] {
  const components = 'components' in parameter ? parameter.components : []
  const record = value as Record<string, unknown>
  return components.flatMap((component, index) =>
    displayValue(component, record[component.name ?? String(index)], `${name}.${component.name ?? index}`),
  )
}

function displayArray(parameter: AbiParameter, value: unknown, name: string): DisplayArgument {
  const items = value as readonly unknown[]
  const elementType = parameter.type.replace(/\[\d*\]$/, '')
  const summary = { name, type: parameter.type, meaning: `${items.length} items` }
  if (items.length === 0) return { ...summary, value: '[]' }
  if (items.length <= MAXIMUM_ARRAY_ITEMS_SHOWN && !elementType.includes('(') && elementType === 'bytes32') {
    return { ...summary, value: items.map(String).join(', ') }
  }
  const digest = keccak256(
    encodeAbiParameters([{ type: parameter.type, components: 'components' in parameter ? parameter.components : undefined } as AbiParameter], [value]),
  )
  return { ...summary, value: `keccak256 of the encoding ${digest}` }
}

function displayScalar(type: string, value: unknown): { value: string; meaning?: string } {
  if (type === 'address' && typeof value === 'string' && isAddress(value, { strict: false })) {
    return { value: getAddress(value) }
  }
  if (type === 'bytes' && typeof value === 'string') return displayBytes(value as Hex)
  if (typeof value === 'bigint') return { value: value.toString() }
  return { value: String(value) }
}

function displayBytes(value: Hex): { value: string; meaning: string } {
  const length = (value.length - 2) / 2
  if (value.length <= MAXIMUM_BYTES_SHOWN) return { value, meaning: `${length} bytes` }
  return { value: `${value.slice(0, 34)}… keccak256 ${keccak256(value)}`, meaning: `${length} bytes` }
}
