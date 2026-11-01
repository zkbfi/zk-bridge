/**
 * Where an icon comes from: a copy the host ships (a map of chain or chain/address to a file, like `public/icons` of the
 * dapp) when there is one, else the image server, a template with `{chainId}` and `{address}`. Both are the host's.
 */
import type { Address } from "viem";

/** The default image server: `{chainId}` and `{address}` are filled in; a chain icon drops `/{address}`. */
export const DEFAULT_IMAGE_SERVER = "https://gib.show/image/{chainId}/{address}";

/** The icons a host ships: key `<chainId>` for a chain, `<chainId>/<lowercase address>` for a token; the value names the file. */
export type ShippedIcons = Readonly<Record<string, { readonly file: string }>>;

/** What an icon shows: a chain (its native coin) or a token on a chain. */
export type IconSubject = { readonly chainId: number; readonly address?: Address | null };

/** Where the icons come from. */
export type IconSources = {
  /** The image server template; default {@link DEFAULT_IMAGE_SERVER}. */
  readonly imageServer?: string;
  /** The icons the host ships; default none. */
  readonly shipped?: ShippedIcons;
  /** The path the shipped files are under, ending in a slash; default `./icons/`. */
  readonly shippedBase?: string;
};

/**
 * The URL of an icon.
 *
 * @param subject The chain, and the token when it is not the chain's own coin.
 * @param sources The image server and the shipped copies.
 */
export const iconUrl = (subject: IconSubject, { imageServer = DEFAULT_IMAGE_SERVER, shipped = {}, shippedBase = "./icons/" }: IconSources = {}): string => {
  const key = subject.address == null ? String(subject.chainId) : `${subject.chainId}/${subject.address.toLowerCase()}`;
  const local = Object.hasOwn(shipped, key) ? shipped[key] : undefined;
  if (local !== undefined) return `${shippedBase}${local.file}`;
  const template = subject.address == null ? imageServer.replace(/\/?\{address\}/, "") : imageServer;
  return template.replace("{chainId}", String(subject.chainId)).replace("{address}", subject.address ?? "");
};
