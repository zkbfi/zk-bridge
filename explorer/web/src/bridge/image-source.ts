/**
 * Where an icon comes from: the copy the release ships (public/icons, downloaded at build time and hash-locked) when
 * there is one, else the image server the user chose in Settings (gib.show by default).
 */
import type { Address } from "viem";
import { DEFAULT_IMAGE_SERVER, iconUrl as iconUrlFrom, type IconSubject } from "@zkb/react";
import type { ChainConfig, PairConfig, TokenInfo } from "@terminal/model/types";
import lock from "../../public/icons/icons.lock.json";

// The default image server and the subject of an icon live in `@zkb/react`.
export { DEFAULT_IMAGE_SERVER };
export type { IconSubject };

const shipped = lock as Readonly<Record<string, { readonly file: string }>>;

/**
 * The URL of an icon (the copies the release ships first, else the image server).
 *
 * @param subject The chain, and the token when it is not the chain's own coin.
 * @param imageServer The image server template.
 */
export const iconUrl = (subject: IconSubject, imageServer: string = DEFAULT_IMAGE_SERVER): string => iconUrlFrom(subject, { imageServer, shipped });

const chainOf = (pair: PairConfig, side: TokenInfo["side"]): ChainConfig => (side === "first" ? pair.first : pair.second);

/**
 * The subject whose icon a token shows. A token minted by this bridge (zkb…) shows its original's icon, and a wrapped
 * native coin shows the chain's own icon, so ETH and its bridged copy look the same (the owner: "the zkbweth should
 * still be the same icon as the input").
 *
 * @param token The token.
 * @param pair The pair it belongs to.
 */
export const iconSubjectOf = (token: TokenInfo, pair: PairConfig): IconSubject => {
  const own = chainOf(pair, token.side);
  const other = chainOf(pair, token.side === "first" ? "second" : "first");
  const isWrappedNative = (chain: ChainConfig, address: Address | null): boolean => address !== null && chain.contracts.wrappedNative?.toLowerCase() === address.toLowerCase();
  if (isWrappedNative(own, token.address) || token.address === "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE") return { chainId: own.chainId };
  if (/^zkb/i.test(token.symbol) && token.counterpart !== null) {
    if (isWrappedNative(other, token.counterpart)) return { chainId: other.chainId };
    return { chainId: other.chainId, address: token.counterpart };
  }
  return { chainId: own.chainId, address: token.address };
};
