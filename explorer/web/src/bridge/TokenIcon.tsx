import { useState } from "react";
import { loadImageServer } from "./image-server";
import { iconUrl, type IconSubject } from "./image-source";

/** Props of {@link TokenIcon}. */
export type TokenIconProps = {
  readonly subject: IconSubject;
  /** The chain a badge in the corner names (the destination of a bridged token), or null. */
  readonly badgeChainId?: number | null;
  /** The symbol, for the alternative text and the lettered fallback. */
  readonly symbol: string;
  readonly size?: number;
  readonly imageServer?: string;
  /** The icon sits next to its own name, so screen readers skip it. */
  readonly decorative?: boolean;
  /** The surface under the icon. On the accent (orange) band it sits on a neutral plate (owner). */
  readonly surface?: "accent" | "plain";
};

/**
 * A token's (or chain's) icon, with an optional chain badge. When an image fails to load it falls back to a lettered
 * disc, never a broken image.
 *
 * @param props The subject, the badge and the symbol.
 */
export const TokenIcon = ({ subject, badgeChainId = null, symbol, size = 24, imageServer = loadImageServer(), decorative = false, surface = "plain" }: TokenIconProps) => {
  const [failed, setFailed] = useState(false);
  const [badgeFailed, setBadgeFailed] = useState(false);
  return (
    <span className={surface === "accent" ? "zb-tok-icon zb-on-accent" : "zb-tok-icon"} style={{ width: surface === "accent" ? size + 4 : size, height: surface === "accent" ? size + 4 : size }}>
      {failed ? (
        <span className="zb-tok-fallback" role="img" aria-label={symbol} style={{ fontSize: Math.max(5, Math.round(size * 0.34)) }}>
          {symbol.replace(/^zkb/i, "").slice(0, 3)}
        </span>
      ) : (
        <img className="zb-main" src={iconUrl(subject, imageServer)} alt={decorative ? "" : symbol} onError={() => setFailed(true)} />
      )}
      {badgeChainId === null || badgeFailed ? null : (
        <img className="zb-badge" src={iconUrl({ chainId: badgeChainId }, imageServer)} alt="" data-badge={badgeChainId} onError={() => setBadgeFailed(true)} />
      )}
    </span>
  );
};
