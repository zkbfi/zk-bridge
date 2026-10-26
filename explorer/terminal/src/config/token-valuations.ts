/**
 * The user's prices of tokens, for the delivery fee suggestions. A fee in the wrapped native token needs no entry,
 * because one whole token is 10^18 wei. A fee in any other token needs the value of one whole token in wei, the same
 * setting as `tokenValuationsWei` of the bots.
 */
import { isAddress } from 'viem'

/** The name of the environment variable that holds the prices. */
export const TOKEN_VALUATIONS_VARIABLE = 'EXPLORER_TOKEN_VALUATIONS_WEI'

/** The setting is not a JSON object of token addresses and wei amounts. */
export class TokenValuationsError extends Error {
  override readonly name = 'TokenValuationsError'
}

/**
 * Reads the prices from the text of the environment variable: a JSON object from a token address to the wei value of
 * one whole token, as a decimal text, for example `{"0x...": "400000000000000"}`.
 *
 * @param text The value of the variable, or undefined when it is not set.
 * @returns The prices by lowercase address. Empty when the variable is not set.
 * @throws TokenValuationsError when the text is malformed, an address is not valid, or a value is not above zero.
 */
export function parseTokenValuations(text: string | undefined): Readonly<Record<string, bigint>> {
  if (text === undefined || text.trim() === '') return {}
  const parsed = parseJson(text)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TokenValuationsError(`${TOKEN_VALUATIONS_VARIABLE} must be a JSON object from token address to wei.`)
  }
  const entries = Object.entries(parsed as Record<string, unknown>).map(([address, value]) => [address.toLowerCase(), valueOf(address, value)] as const)
  return Object.freeze(Object.fromEntries(entries))
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    throw new TokenValuationsError(`${TOKEN_VALUATIONS_VARIABLE} is not valid JSON.`)
  }
}

function valueOf(address: string, value: unknown): bigint {
  if (!isAddress(address, { strict: false })) throw new TokenValuationsError(`${TOKEN_VALUATIONS_VARIABLE}: "${address}" is not an address.`)
  if (typeof value !== 'string' || !/^\d+$/.test(value) || BigInt(value) === 0n) {
    throw new TokenValuationsError(`${TOKEN_VALUATIONS_VARIABLE}: the value for ${address} must be a decimal text above zero.`)
  }
  return BigInt(value)
}
