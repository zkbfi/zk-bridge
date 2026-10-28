/**
 * Decoding of calldata into the lines that the confirmation screen shows.
 */
import { displayArguments } from '@zk-bridge/shared'
import { decodeFunctionData, toFunctionSignature, toFunctionSelector, type Abi, type AbiFunction, type Hex } from 'viem'
import { knownAbis } from './abis'
import type { DisplayArgument } from './plan'

/** The decoded form of calldata that a known ABI matched. */
export interface DecodedCall {
  readonly functionName: string
  readonly functionSignature: string
  readonly arguments: readonly DisplayArgument[]
}

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

/** The selector of calldata: the first four bytes, or `null` for shorter data. */
export function selectorOf(data: Hex): Hex | null {
  return data.length >= 10 ? (data.slice(0, 10) as Hex) : null
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
