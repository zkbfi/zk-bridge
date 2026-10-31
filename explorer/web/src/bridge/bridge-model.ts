/**
 * Pure helpers of the bridge screen: which chain is the source for a direction, which tokens it can send, the
 * counterpart a flip moves to, and how long a transfer takes.
 */
import type { ChainSnapshotResult } from "@terminal/chain/live-reads";
import type { ChainConfig, ChainSide, Direction, LightClientHead, PairConfig, TokenInfo } from "@terminal/model/types";
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

/**
 * The account's balance of a token, from the snapshots: the native balance for a chain's native coin, else its position.
 * Null when the chain has no snapshot or the token no position.
 */
export const tokenBalance = (token: TokenInfo, snapshots: readonly ChainSnapshotResult[]): bigint | null => {
  const found = snapshots.find((result) => result.status === "ok" && result.snapshot.chain.side === token.side);
  if (found === undefined || found.status !== "ok") return null;
  if (isNativeToken(token)) return found.snapshot.nativeBalance;
  return found.snapshot.positions.find((position) => position.token.address === token.address)?.balance ?? null;
};

/** The gas MAX leaves for sending the native coin: the wrap-and-relay transaction with room to spare. */
export const GAS_RESERVE_GAS = 400_000n;

/**
 * What MAX fills in: the whole balance of a token; for the native coin, the balance less {@link GAS_RESERVE_GAS} at the
 * source chain's max fee per gas (null until that fee is read, so MAX never drains the account).
 */
export const maxSendable = (token: TokenInfo, balance: bigint, maxFeePerGasWei: bigint | null): bigint | null => {
  if (!isNativeToken(token)) return balance;
  if (maxFeePerGasWei === null) return null;
  const left = balance - GAS_RESERVE_GAS * maxFeePerGasWei;
  return left > 0n ? left : 0n;
};

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
 * The token a flip moves to, keeping the asset (owner, quotes 101–102): a token's counterpart on the other chain; the
 * native coin's counterpart is its wrapped native token's counterpart (ETH on Ethereum ↔ zkbWETH on PulseChain); and a
 * counterpart that is the other chain's wrapped native token lands on that chain's native coin when the list has it.
 * Only a token with no counterpart in the list falls back to the other chain's first token.
 *
 * @param token The token now chosen.
 * @param tokens Every token of the pair.
 * @param pair The pair, for each chain's wrapped native token; without it the native coin has no counterpart.
 */
export const counterpartOf = (token: TokenInfo, tokens: readonly TokenInfo[], pair?: PairConfig): TokenInfo | null => {
  const otherSide: ChainSide = token.side === "first" ? "second" : "first";
  const chainOf = (side: ChainSide) => (pair === undefined ? null : side === "first" ? pair.first : pair.second);
  const same = (a: string | null | undefined, b: string | null | undefined): boolean => a != null && b != null && a.toLowerCase() === b.toLowerCase();
  // The native coin stands for its chain's wrapped native token, whose copy is what crosses.
  const wrapped = isNativeToken(token) ? (chainOf(token.side)?.contracts.wrappedNative ?? null) : null;
  const address = wrapped ?? token.address;
  const asToken = wrapped === null ? token : (tokens.find((candidate) => candidate.side === token.side && same(candidate.address, wrapped)) ?? { ...token, address: wrapped, counterpart: null });
  const others = tokens.filter((candidate) => candidate.side === otherSide && !isNativeToken(candidate));
  const found = others.find((candidate) => same(candidate.address, asToken.counterpart)) ?? others.find((candidate) => same(candidate.counterpart, address)) ?? null;
  if (found !== null) {
    // Back home to the wrapped native token: the native coin, when the list offers it.
    const otherWrapped = chainOf(otherSide)?.contracts.wrappedNative ?? null;
    const native = tokens.find((candidate) => candidate.side === otherSide && isNativeToken(candidate));
    return same(found.address, otherWrapped) && native !== undefined ? native : found;
  }
  return tokens.find((candidate) => candidate.side === otherSide && !isNativeToken(candidate)) ?? tokens.find((candidate) => candidate.side === otherSide) ?? null;
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
/**
 * How far behind the light client a transfer from `sourceSide` waits for is (the destination's head of the source
 * chain, from the indexer's heads), when it is over an hour; else null.
 *
 * @param heads The light-client heads of the pair.
 * @param sourceSide The side the transfer leaves from.
 */
export const lightClientDelay = (heads: readonly LightClientHead[], sourceSide: ChainSide): { readonly seconds: number; readonly text: string } | null => {
  const head = heads.find((candidate) => candidate.side !== sourceSide);
  if (head === undefined || head.lagSlots === null) return null;
  const seconds = Number(head.lagSlots) * head.secondsPerSlot;
  if (seconds <= 3600) return null;
  return { seconds, text: `light client ${Math.round(seconds / 3600)} h behind` };
};

export const transferEstimate =(source: ChainConfig, destination: ChainConfig): string =>
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
