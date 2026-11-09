/**
 * The native coin with a tip. The delivery router of the source chain has `relayTokensAndCall(receiver, data,
 * callbackGas)`, payable: it wraps the coin and relays the wrapped token with the data. Naming the delivery router of the
 * other chain as the receiver, with its terms as the data, pays a tip there, exactly as a token relay to that router does.
 * What crosses is the wrapped native token of the source chain, so the router of the other chain receives its copy (such
 * as zSepETH) and pays the recipient in that copy.
 *
 * The copy is never the wrapped native token of the other chain, so the router cannot unwrap it: the "pay out in the
 * native coin" option does not apply here, and the shared guard refuses the unwrap flag for it.
 */
import { bridgedSymbolOf } from "@zk-bridge/shared";
import { getAddress, type Address } from "viem";
import type { BridgeSource } from "@terminal/app/actions";
import type { ChainConfig, TokenInfo } from "@terminal/model/types";

const same = (a: string | null | undefined, b: string | null | undefined): boolean => a != null && b != null && a.toLowerCase() === b.toLowerCase();

/**
 * The wrapped native token of the source chain, as the token that crosses, with its copy on the other chain when the
 * token list knows it. Null when the chain has no wrapped native token.
 *
 * @param chain The source chain.
 * @param tokens Every token of the pair.
 */
export const wrappedNativeTokenOf = (chain: ChainConfig, tokens: readonly TokenInfo[]): TokenInfo | null => {
  const wrapped = chain.contracts.wrappedNative;
  if (wrapped === null) return null;
  const listed = tokens.find((token) => token.side === chain.side && same(token.address, wrapped));
  if (listed !== undefined) return listed;
  // The list may hold only the copy on the other chain, whose counterpart is the wrapped token.
  const copy = tokens.find((token) => token.side !== chain.side && same(token.counterpart, wrapped));
  return { address: getAddress(wrapped), symbol: `wrapped ${chain.nativeSymbol}`, decimals: 18, side: chain.side, counterpart: copy === undefined ? null : getAddress(copy.address) };
};

/**
 * The source that the fee rules read for a send: a native coin reads as its wrapped native token, which is what crosses.
 * A token source, or a chain with no wrapped native token, is returned as it is.
 *
 * @param source The source of the form.
 * @param tokens Every token of the pair.
 */
export const crossingSourceOf = (source: BridgeSource, tokens: readonly TokenInfo[]): BridgeSource => {
  if (source.kind !== "native") return source;
  const token = wrappedNativeTokenOf(source.chain, tokens);
  return token === null ? source : { kind: "token", side: source.side, chain: source.chain, token };
};

/**
 * The symbol of the copy that the router of the other chain receives for a native send: the listed copy's symbol, or
 * else the copy's name by the bridge's naming rule (zSepETH for SepETH), which is what the form says it arrives as.
 *
 * @param chain The source chain.
 * @param tokens Every token of the pair.
 */
export const crossingCopySymbolOf = (chain: ChainConfig, tokens: readonly TokenInfo[]): string => {
  const counterpart = wrappedNativeTokenOf(chain, tokens)?.counterpart ?? null;
  const listed = counterpart === null ? undefined : tokens.find((token) => token.side !== chain.side && same(token.address, counterpart));
  return listed?.symbol ?? bridgedSymbolOf(chain.nativeSymbol);
};

/** The copy of the wrapped native token of `chain` on the other chain, or null when the list does not know it yet. */
export const crossingCopyOf = (chain: ChainConfig, tokens: readonly TokenInfo[]): Address | null => wrappedNativeTokenOf(chain, tokens)?.counterpart ?? null;

