/**
 * The symbol rule of a bridged copy: the token mediator gives the copy of a native token the symbol of the native token
 * with this prefix in front and no separator (`WETH` becomes `zWETH`). This is the only place off-chain code names the
 * prefix; the contract holds the same text in `TokenMediator.SYMBOL_PREFIX`.
 *
 * The prefix is one letter, so a symbol cannot tell a copy from a native token (`ZRX` and `zkSync` start with it). Code
 * that asks "is this a copy" uses what it knows about the token (the indexer's `isBridgedCopy`), never the symbol.
 */
export const BRIDGED_SYMBOL_PREFIX = "z";

/**
 * The symbol that the copy of a native token gets.
 *
 * @param nativeSymbol The symbol of the native token.
 */
export const bridgedSymbolOf = (nativeSymbol: string): string => `${BRIDGED_SYMBOL_PREFIX}${nativeSymbol}`;

/**
 * The symbol of the native token that a token stands for: a copy without its prefix, any other token as it is. A native
 * token whose symbol starts with the prefix (`ZRX`) is not a copy and keeps its symbol.
 *
 * @param token The symbol of the token and whether the bridge minted it as a copy.
 */
export const nativeSymbolOf = (token: { readonly symbol: string; readonly isBridgedCopy?: boolean | undefined }): string =>
  token.isBridgedCopy === true && token.symbol.startsWith(BRIDGED_SYMBOL_PREFIX) ? token.symbol.slice(BRIDGED_SYMBOL_PREFIX.length) : token.symbol;
