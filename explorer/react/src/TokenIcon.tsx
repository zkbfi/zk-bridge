import { useState } from "react";
import { nativeSymbolOf } from "@zkb/core";
import { iconUrl, type IconSources, type IconSubject } from "./icon-source.js";

/** Props of {@link TokenIcon}. */
export type TokenIconProps = IconSources & {
  readonly subject: IconSubject;
  /** The chain a badge in the corner names (the destination of a bridged token), or null. */
  readonly badgeChainId?: number | null;
  /** The symbol, for the alternative text and the lettered fallback. */
  readonly symbol: string;
  /** The token is a bridged copy, so the lettered fallback shows the native symbol (a symbol alone cannot tell). */
  readonly isBridgedCopy?: boolean | undefined;
  readonly size?: number;
  /** The icon sits next to its own name, so screen readers skip it. */
  readonly decorative?: boolean;
  /** The surface under the icon. On the accent band it sits on a neutral plate. */
  readonly surface?: "accent" | "plain";
};

/**
 * A token's (or chain's) icon, with an optional chain badge. When an image fails to load it falls back to a lettered
 * disc, never a broken image. Icons are only ever drawn through `<img>`.
 *
 * @param props The subject, the badge, the symbol and where icons come from.
 */
export const TokenIcon = ({ subject, badgeChainId = null, symbol, isBridgedCopy = false, size = 24, decorative = false, surface = "plain", imageServer, shipped, shippedBase }: TokenIconProps) => {
  const [failed, setFailed] = useState(false);
  const [badgeFailed, setBadgeFailed] = useState(false);
  const sources: IconSources = { ...(imageServer === undefined ? {} : { imageServer }), ...(shipped === undefined ? {} : { shipped }), ...(shippedBase === undefined ? {} : { shippedBase }) };
  return (
    <span className={surface === "accent" ? "zb-tok-icon zb-on-accent" : "zb-tok-icon"} style={{ width: surface === "accent" ? size + 4 : size, height: surface === "accent" ? size + 4 : size }}>
      {failed ? (
        <span className="zb-tok-fallback" role="img" aria-label={symbol} style={{ fontSize: Math.max(5, Math.round(size * 0.34)) }}>
          {nativeSymbolOf({ symbol, isBridgedCopy }).slice(0, 3)}
        </span>
      ) : (
        <img className="zb-main" src={iconUrl(subject, sources)} alt={decorative ? "" : symbol} onError={() => setFailed(true)} />
      )}
      {badgeChainId === null || badgeFailed ? null : (
        <img className="zb-badge" src={iconUrl({ chainId: badgeChainId }, sources)} alt="" data-badge={badgeChainId} onError={() => setBadgeFailed(true)} />
      )}
    </span>
  );
};
