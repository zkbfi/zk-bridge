/**
 * The tokens of the run, in the shape that the terminal wants, and the balance reads that the checks use.
 */
import { erc20Abi, type Address } from "viem";
import { tokenFactoryAbi } from "@zk-bridge/shared";
import type { TokenInfo } from "../../terminal/src/model/types";
import { chainOf, type Context, type Side } from "./context.ts";

/** A token that the run uses. `home` is the chain where the token is native. */
export interface RunToken {
  readonly key: "tokenA" | "blockableA" | "wrappedA" | "tokenB" | "wrappedB";
  readonly symbol: string;
  readonly home: Side;
  readonly address: Address;
}

/** The native tokens of the run. */
export const nativeTokens = (context: Context): readonly RunToken[] => [
  { key: "tokenA", symbol: "TKNA", home: "a", address: context.run.tokens.a },
  { key: "blockableA", symbol: "BLKA", home: "a", address: context.run.tokens.blockableA },
  { key: "wrappedA", symbol: "WNAT", home: "a", address: context.run.tokens.wrappedA },
  { key: "tokenB", symbol: "TKNB", home: "b", address: context.run.tokens.b },
  { key: "wrappedB", symbol: "WNAT", home: "b", address: context.run.tokens.wrappedB },
];

/** The address of the bridged copy of a native token on the other chain, predicted by the factory of that chain. */
export const copyOf = async (context: Context, token: RunToken): Promise<Address> => {
  const other = chainOf(context, token.home === "a" ? "b" : "a");
  const home = chainOf(context, token.home);
  return (await other.publicClient.readContract({
    address: other.deployment.token_factory,
    abi: tokenFactoryAbi,
    functionName: "predictAddress",
    args: [BigInt(home.deployment.chain_id), token.address],
  })) as Address;
};

/** The tokens in the shape of the terminal: each native token and each copy, with its counterpart. */
export const terminalTokens = async (context: Context): Promise<readonly TokenInfo[]> => {
  const infos: TokenInfo[] = [];
  for (const token of nativeTokens(context)) {
    const copy = await copyOf(context, token);
    const homeSide = token.home === "a" ? "first" : "second";
    const otherSideName = token.home === "a" ? "second" : "first";
    infos.push({ address: token.address, symbol: token.symbol, decimals: 18, side: homeSide, counterpart: copy });
    infos.push({ address: copy, symbol: `zkb${token.symbol}`, decimals: 18, side: otherSideName, counterpart: token.address });
  }
  return infos;
};

/** The value of one whole token in wei, by the address of the token on its own chain. Every token of the run is worth 0.001 coin. */
export const valuationsWei = async (context: Context): Promise<Readonly<Record<string, string>>> => {
  const entries: [string, string][] = [];
  for (const token of nativeTokens(context)) {
    if (token.key === "wrappedA" || token.key === "wrappedB") continue;
    entries.push([token.address.toLowerCase(), "1000000000000000"]);
    entries.push([(await copyOf(context, token)).toLowerCase(), "1000000000000000"]);
  }
  return Object.fromEntries(entries);
};

/** The balance of an account in a token at a block, or the native balance for the zero address token. */
export const balanceAt = async (context: Context, side: Side, token: Address | "native", account: Address, blockNumber: bigint): Promise<bigint> => {
  const chain = chainOf(context, side);
  if (token === "native") return chain.publicClient.getBalance({ address: account, blockNumber });
  const code = await chain.publicClient.getCode({ address: token, blockNumber });
  if (code === undefined || code === "0x") return 0n;
  return (await chain.publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [account], blockNumber })) as bigint;
};

/** The change of a balance in the block of a transaction: the balance after minus the balance in the block before. */
export const balanceChange = async (context: Context, side: Side, token: Address | "native", account: Address, blockNumber: bigint): Promise<bigint> =>
  (await balanceAt(context, side, token, account, blockNumber)) - (await balanceAt(context, side, token, account, blockNumber - 1n));
