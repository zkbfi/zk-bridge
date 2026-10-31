/**
 * Custom tokens (owner: "tokens that neither bridge has ever seen"): a pasted address that is in no list is read
 * on-chain (symbol, name, decimals) over the user's RPC. A contract that does not answer as an ERC-20 is refused.
 */
import { createPublicClient, erc20Abi, getAddress, isAddress, type Address } from "viem";
import { rpcTransport } from "../app/rpc-transport";
import type { ChainSide, TokenInfo } from "@terminal/model/types";

/** Reads one ERC-20 view of a token. */
export type Erc20Reader = (address: Address, fn: "symbol" | "name" | "decimals") => Promise<unknown>;

/** A token the user pasted, read on-chain; its icon comes from the image server, else the lettered disc. */
export type CustomToken = TokenInfo & { readonly name: string; readonly custom: true };

const PRINTABLE = /^[\x20-\x7e]{1,32}$/;

/** Whether a search text is a full address. */
export const isTokenAddress = (text: string): text is Address => isAddress(text.trim(), { strict: false });

/**
 * Reads a pasted token. Null when the address is not a contract that answers as an ERC-20 (a symbol of 1 to 32
 * printable characters and decimals from 0 to 36).
 *
 * @param text The pasted address.
 * @param side The chain it is on.
 * @param read The reader over that chain's RPC.
 */
export const resolveCustomToken = async (text: string, side: ChainSide, read: Erc20Reader): Promise<CustomToken | null> => {
  if (!isTokenAddress(text)) return null;
  const address = getAddress(text.trim());
  try {
    const [symbol, decimals, name] = await Promise.all([read(address, "symbol"), read(address, "decimals"), read(address, "name").catch(() => "")]);
    const places = typeof decimals === "bigint" ? Number(decimals) : typeof decimals === "number" ? decimals : NaN;
    if (typeof symbol !== "string" || !PRINTABLE.test(symbol) || !Number.isInteger(places) || places < 0 || places > 36) return null;
    return { address, symbol, name: typeof name === "string" && PRINTABLE.test(name) ? name : symbol, decimals: places, side, counterpart: null, custom: true };
  } catch {
    return null;
  }
};

/**
 * An ERC-20 reader over an RPC URL (the user's, from the settings).
 *
 * @param rpcUrl The RPC of the chain.
 */
export const erc20ReaderFor = (rpcUrl: string): Erc20Reader => {
  const client = createPublicClient({ transport: rpcTransport(rpcUrl) });
  return (address, fn) => client.readContract({ address, abi: erc20Abi, functionName: fn });
};

/**
 * Whether a token would be bridged by zkb.fi for the first time: it is in none of the pair's token lists (no deployed
 * counterpart), and it is not an Omnibridge copy (which has its own warning).
 *
 * @param token The token.
 * @param known The tokens of the pair.
 * @param omnibridge Whether it is an Omnibridge copy.
 */
export const isFirstBridge = (token: TokenInfo, known: readonly TokenInfo[], omnibridge: boolean): boolean =>
  !omnibridge && !known.some((candidate) => candidate.side === token.side && candidate.address.toLowerCase() === token.address.toLowerCase());
