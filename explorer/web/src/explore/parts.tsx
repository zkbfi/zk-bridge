/**
 * The pieces every Explore page shares: a row (icon, title over a subtitle, a one-word status pill, the chevron at the
 * far right), a route as chain icons, a key/value line, a section heading, and the underlined match of a search.
 */
import type { ReactNode } from "react";
import { Chevron } from "../bridge/icons";
import { TokenIcon } from "../bridge/TokenIcon";

/** A route: the source chain's icon, a chevron, the destination chain's icon (never words, owner). */
export const RouteIcons = ({ from, to, names, surface = "plain" }: { readonly from: number; readonly to: number; readonly names: (chainId: number) => string; readonly surface?: "accent" | "plain" }) => (
  <span className="zb-xroute" aria-label={`${names(from)} to ${names(to)}`}>
    <TokenIcon subject={{ chainId: from }} symbol={names(from)} size={18} surface={surface} decorative />
    <Chevron dir="right" />
    <TokenIcon subject={{ chainId: to }} symbol={names(to)} size={18} surface={surface} decorative />
  </span>
);

/** The part of a text that matched a search, underlined in the accent (not filled). */
export const Marked = ({ text, match }: { readonly text: string; readonly match: string | null }) => {
  if (match === null || match === "") return <>{text}</>;
  const at = text.toLowerCase().indexOf(match.toLowerCase());
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark className="zb-match">{text.slice(at, at + match.length)}</mark>
      {text.slice(at + match.length)}
    </>
  );
};

/** A row that leads onward: icon, title over subtitle, an optional one-word status pill, the chevron at the far right. */
export const XRow = ({ href, icon, title, sub, status }: { readonly href: string; readonly icon?: ReactNode; readonly title: ReactNode; readonly sub?: ReactNode; readonly status?: string }) => (
  <a className="zb-xrow" href={href}>
    {icon === undefined ? null : <span className="zb-xrow-icon">{icon}</span>}
    <span className="zb-xrow-text">
      <b>{title}</b>
      {sub === undefined ? null : <span>{sub}</span>}
    </span>
    {status === undefined ? null : <span className="zb-xstatus" data-status={status}>{status}</span>}
    <Chevron dir="right" />
  </a>
);

/** A section heading with an optional count or link on the right. */
export const XGroup = ({ title, right }: { readonly title: string; readonly right?: ReactNode }) => (
  <h3 className="zb-xgrp">
    <span>{title}</span>
    {right === undefined ? null : <span className="zb-xgrp-r">{right}</span>}
  </h3>
);

/** A key/value line. The value may link onward. */
export const KV = ({ k, children, href }: { readonly k: string; readonly children: ReactNode; readonly href?: string }) => (
  <div className="zb-kv zb-xkv">
    <span className="zb-k">{k}</span>
    {href === undefined ? (
      <span className="zb-xv">{children}</span>
    ) : (
      <a className="zb-xv" href={href}>
        {children}
        <Chevron dir="right" />
      </a>
    )}
  </div>
);

/** The orange band at the top of a page: a label, the big name, a second label, and an optional row of tags. */
export const XBand = ({ label, big, sub, icon, tags }: { readonly label: ReactNode; readonly big: ReactNode; readonly sub?: ReactNode; readonly icon?: ReactNode; readonly tags?: ReactNode }) => (
  <section className="zb-xband">
    <div className="zb-col zb-xband-in">
      {icon === undefined ? null : icon}
      <div>
        <div className="zb-xband-lbl">{label}</div>
        <div className="zb-xband-big">{big}</div>
        {sub === undefined ? null : <div className="zb-xband-lbl">{sub}</div>}
        {tags === undefined ? null : <div className="zb-xband-tags">{tags}</div>}
      </div>
    </div>
  </section>
);

/** A hash or address shortened for a row: 0x4663c8c2…28db. */
export const shortHex = (value: string): string => (value.length <= 14 ? value : `${value.slice(0, 10)}…${value.slice(-4)}`);
