/**
 * The bridge screen's icons: line icons in the current text colour. Chevrons for every menu and disclosure (never a
 * caret); a sliders icon for settings (never a gear); an identicon for the account.
 */
import type { Address } from "viem";

type IconProps = { readonly title?: string; readonly className?: string };

const svgProps = (title: string | undefined, className = "zb-icon") =>
  title === undefined ? { className, "aria-hidden": true as const, focusable: "false" as const } : { className, role: "img" as const, "aria-label": title };

/** A chevron pointing down (menus), right (links into a page), up or left. */
export const Chevron = ({ dir = "down", title }: IconProps & { readonly dir?: "down" | "up" | "left" | "right" }) => {
  const paths = { down: "M3 4.5 6 7.5l3-3", up: "M3 7.5 6 4.5l3 3", right: "M4.5 3 7.5 6l-3 3", left: "M7.5 3 4.5 6l3 3" };
  return (
    <svg viewBox="0 0 12 12" {...svgProps(title, "zb-icon zb-chev")}>
      <path d={paths[dir]} />
    </svg>
  );
};

/** Two sliders: the delivery settings. */
export const SlidersIcon = ({ title }: IconProps) => (
  <svg viewBox="0 0 16 16" {...svgProps(title)}>
    <path d="M2 4h7M12 4h2M2 12h2M7 12h7" />
    <circle cx="10.5" cy="4" r="1.6" />
    <circle cx="5.5" cy="12" r="1.6" />
  </svg>
);

/** A hand holding money: the tip ("take my money"). */
export const MoneyHand = ({ title }: IconProps) => (
  <svg viewBox="0 0 24 24" {...svgProps(title)}>
    <path d="M3 11.5h3.5v8H3z" />
    <path d="M6.5 12.5l3.2-2.6a2 2 0 0 1 2.4 0l1 .8h3.4a1.5 1.5 0 0 1 0 3H12" />
    <path d="M6.5 18.5h8.6a2 2 0 0 0 1.4-.6l4.2-4.3a1.4 1.4 0 0 0-2-2l-3.2 2.9" />
    <rect x="11" y="2.5" width="9" height="5.5" rx="1" />
    <circle cx="15.5" cy="5.25" r="1.1" />
  </svg>
);

/** A gas can, with bars that show the gas level chosen (0 to 3). Gas is never written as a word. */
export const GasCan = ({ title, level }: IconProps & { readonly level?: 0 | 1 | 2 | 3 }) => (
  <span style={{ display: "inline-flex", alignItems: "flex-end", gap: 3 }}>
    <svg viewBox="0 0 24 24" {...svgProps(title)}>
      <path d="M6 4h7l5 5v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z" />
      <path d="M13 4v5h5" />
      <path d="M7 4V2.5h4V4" />
      <path d="M8.5 12.5l5 5M13.5 12.5l-5 5" />
    </svg>
    {level === undefined ? null : (
      <svg viewBox="0 0 10 12" width="9" height="11" aria-hidden="true" focusable="false" data-level={level}>
        {[0, 1, 2].map((bar) => (
          <rect key={bar} x={bar * 3.5} y={8 - bar * 3} width="2.4" height={4 + bar * 3} rx="1.2" fill={bar < level ? "currentColor" : "var(--zb-pill-edge)"} />
        ))}
      </svg>
    )}
  </span>
);

/** A clock: the time a transfer takes. */
export const ClockIcon = ({ title }: IconProps) => (
  <svg viewBox="0 0 24 24" {...svgProps(title)}>
    <circle cx="12" cy="13" r="8" />
    <path d="M12 9v4l2.5 2" />
    <path d="M9.5 2.5h5" />
  </svg>
);

/** A link that leaves the page (a block explorer). */
export const ExternalLink = ({ title }: IconProps) => (
  <svg viewBox="0 0 16 16" {...svgProps(title)}>
    <path d="M9.5 2.5h4v4" />
    <path d="M13.5 2.5 7.5 8.5" />
    <path d="M12 9.5V13a.5.5 0 0 1-.5.5h-8A.5.5 0 0 1 3 13V5a.5.5 0 0 1 .5-.5H7" />
  </svg>
);

/** Two sheets: copy a value. */
export const CopyIcon = ({ title }: IconProps) => (
  <svg viewBox="0 0 16 16" {...svgProps(title)}>
    <rect x="5.5" y="5.5" width="8" height="9" rx="1" />
    <path d="M3 11V3a1 1 0 0 1 1-1h6" />
  </svg>
);

/** Two arrows: swap the direction. */
export const FlipIcon = ({ title }: IconProps) => (
  <svg viewBox="0 0 16 16" {...svgProps(title)}>
    <path d="M5 2.5v11M2.5 5 5 2.5 7.5 5" />
    <path d="M11 13.5v-11M8.5 11l2.5 2.5 2.5-2.5" />
  </svg>
);

/** A magnifier: search. */
export const SearchIcon = ({ title }: IconProps) => (
  <svg viewBox="0 0 16 16" {...svgProps(title)}>
    <circle cx="7" cy="7" r="4.5" />
    <path d="m10.5 10.5 3 3" />
  </svg>
);

/**
 * The account's identicon: four quarters coloured from the address, so the same account always looks the same.
 *
 * @param props The address.
 */
export const Identicon = ({ address }: { readonly address: Address | null }) => {
  if (address === null) return <span className="zb-ident" style={{ background: "var(--zb-pill-edge)" }} aria-hidden="true" />;
  const hue = (index: number): string => `hsl(${parseInt(address.slice(2 + index * 6, 8 + index * 6), 16) % 360} 70% 55%)`;
  return <span className="zb-ident" aria-hidden="true" style={{ background: `conic-gradient(${hue(0)} 0 25%, ${hue(1)} 0 50%, ${hue(2)} 0 75%, ${hue(3)} 0)` }} />;
};
