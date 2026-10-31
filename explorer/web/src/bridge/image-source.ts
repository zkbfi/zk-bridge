/**
 * Where an icon comes from: the copy the release ships (public/icons, downloaded at build time and hash-locked) when
 * there is one, else the image server the user chose in Settings (gib.show by default).
 */
import type { Address } from "viem";
import type { ChainConfig, PairConfig, TokenInfo } from "@terminal/model/types";
import lock from "../../public/icons/icons.lock.json";

/** The default image server: `{chainId}` and `{address}` are filled in; a chain icon drops `/{address}`. */
export const DEFAULT_IMAGE_SERVER = "https://gib.show/image/{chainId}/{address}";

const shipped = lock as Readonly<Record<string, { readonly file: string }>>;

/** What an icon shows: a chain (its native coin) or a token on a chain. */
export type IconSubject = { readonly chainId: number; readonly address?: Address | null };

/**
 * The URL of an icon.
 *
 * @param subject The chain, and the token when it is not the chain's own coin.
 * @param imageServer The image server template.
 */
export const iconUrl = (subject: IconSubject, imageServer: string = DEFAULT_IMAGE_SERVER): string => {
  const key = subject.address == null ? String(subject.chainId) : `${subject.chainId}/${subject.address.toLowerCase()}`;
  const local = shipped[key];
  if (local !== undefined) return `./icons/${local.file}`;
  const template = subject.address == null ? imageServer.replace(/\/?\{address\}/, "") : imageServer;
  return template.replace("{chainId}", String(subject.chainId)).replace("{address}", subject.address ?? "");
};

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
