/**
 * Pure helpers of the bridge screen: which chain is the source for a direction, which tokens it can send, the
 * counterpart a flip moves to, and how long a transfer takes.
 */
import type { ChainConfig, ChainSide, Direction, PairConfig, TokenInfo } from "@terminal/model/types";
import { formatUnits } from "../ui/format";

/** The source and destination chains of a direction. */
export const chainsFor = (pair: PairConfig, dir: Direction): { readonly source: ChainConfig; readonly destination: ChainConfig } =>
  dir === "first-to-second" ? { source: pair.first, destination: pair.second } : { source: pair.second, destination: pair.first };

/** The side a direction sends from. */
export const sourceSide = (dir: Direction): ChainSide => (dir === "first-to-second" ? "first" : "second");

/** The other direction. */
export const reverse = (dir: Direction): Direction => (dir === "first-to-second" ? "second-to-first" : "first-to-second");

/** The direction that sends from a side. */
export const directionFrom = (side: ChainSide): Direction => (side === "first" ? "first-to-second" : "second-to-first");

/** The form's value for a token: `<side>:<address>`. */
export const choiceOf = (token: TokenInfo): string => (isNativeToken(token) ? `${token.side}:native` : `${token.side}:${token.address}`);

/** The address that stands for a chain's native coin in the token list (the wrap route bridges it). */
export const NATIVE_ADDRESS = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" as const;

/** Whether a token of the list is a chain's native coin. */
export const isNativeToken = (token: TokenInfo): boolean => token.address === NATIVE_ADDRESS;

/**
 * The native coin of each chain that has the wrap route (a wrapped native token), as tokens of the list, so a pair
 * with nothing bridged yet still has something to bridge (ETH on Ethereum or Sepolia, PLS on PulseChain).
 *
 * @param pair The pair.
 */
export const nativeTokensOf = (pair: PairConfig): readonly TokenInfo[] =>
  [pair.first, pair.second]
    .filter((chain) => chain.contracts.wrappedNative !== null)
    .map((chain) => ({ address: NATIVE_ADDRESS, symbol: chain.nativeSymbol, decimals: 18, side: chain.side, counterpart: null }));

/**
 * The token a choice names, when it is a token of the given side; else the side's first token (the default).
 *
 * @param choice The form's token value, or undefined.
 * @param tokens Every token of the pair.
 * @param side The side the transfer leaves from.
 */
export const tokenFor = (choice: string | undefined, tokens: readonly TokenInfo[], side: ChainSide): TokenInfo | null => {
  const named = tokens.find((token) => choiceOf(token) === choice && token.side === side);
  return named ?? tokens.find((token) => token.side === side) ?? null;
};

/**
 * The token a flip moves to: the token's counterpart on the other chain, or that chain's first token.
 *
 * @param token The token now chosen.
 * @param tokens Every token of the pair.
 */
export const counterpartOf = (token: TokenInfo, tokens: readonly TokenInfo[]): TokenInfo | null => {
  const otherSide: ChainSide = token.side === "first" ? "second" : "first";
  const byCounterpart = tokens.find((candidate) => candidate.side === otherSide && candidate.address.toLowerCase() === token.counterpart?.toLowerCase());
  const byReference = tokens.find((candidate) => candidate.side === otherSide && candidate.counterpart?.toLowerCase() === token.address.toLowerCase());
  return byCounterpart ?? byReference ?? tokens.find((candidate) => candidate.side === otherSide) ?? null;
};

/** The steps a transfer goes through, with an estimate each, for the time drawer. */
export type TransferStep = { readonly label: string; readonly estimate: string; readonly seconds: number };

/** Ethereum-like chains finalize in about two epochs; PulseChain's epochs are shorter (10 s slots). */
const finalitySeconds = (chainId: number): number => (chainId === 369 || chainId === 943 ? 32 * 10 * 2 + 60 : 32 * 12 * 2 + 30);

const minutes = (seconds: number): string => (seconds < 60 ? `~${seconds} s` : `~${Math.round(seconds / 60)} min`);

/**
 * Every technical step from sending to delivery, with an estimate each (owner: "the duration can tell the user all
 * of the different technical steps").
 *
 * @param source The chain the transfer leaves from.
 * @param destination The chain it arrives on.
 */
export const transferSteps = (source: ChainConfig, destination: ChainConfig): readonly TransferStep[] => {
  const rows: Array<[string, number]> = [
    [`Sent on ${source.name}`, source.chainId === 369 || source.chainId === 943 ? 10 : 12],
    [`Final on ${source.name}`, finalitySeconds(source.chainId)],
    [`Proof of the finalized block`, 120],
    [`${destination.name}'s light client checks it`, destination.chainId === 369 || destination.chainId === 943 ? 10 : 12],
    [`Delivered to the address`, destination.chainId === 369 || destination.chainId === 943 ? 10 : 12],
  ];
  return rows.map(([label, seconds]) => ({ label, seconds, estimate: minutes(seconds) }));
};

/** The total of {@link transferSteps}, as "~15 min". */
export const transferEstimate = (source: ChainConfig, destination: ChainConfig): string =>
  minutes(transferSteps(source, destination).reduce((sum, step) => sum + step.seconds, 0));

/**
 * A plain decimal text of an amount for display (no grouping, at most 6 decimals, trailing zeros dropped), so the
 * leading-zeros rule can read it.
 *
 * @param value The amount in base units.
 * @param decimals The token's decimals.
 */
export const amountText = (value: bigint, decimals: number): string => {
  const digits = value > 0n && value < 10n ** BigInt(Math.max(0, decimals - 6)) ? decimals : 6;
  return formatUnits(value, decimals, { maximumFractionDigits: Math.min(digits, decimals) });
};
