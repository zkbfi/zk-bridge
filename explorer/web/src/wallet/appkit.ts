/**
 * Reown AppKit, loaded on demand. The package and its wagmi adapter are large, so nothing here is imported at the top
 * of the page: {@link loadAppKit} imports them when a viewer first connects (or when the viewer connected through
 * AppKit before). A page without a Reown project id never calls it.
 */
import type { Config, Transport } from "wagmi";
import type { Chain } from "viem";

/** What {@link loadAppKit} needs. */
export type AppKitOptions = {
  readonly projectId: string;
  /** The chains of the pair. */
  readonly chains: readonly [Chain, ...Chain[]];
  /** The transport of each chain: the same ones the page reads with. */
  readonly transports: Readonly<Record<number, Transport>>;
};

/** The loaded modal and the wagmi configuration that it owns. */
export type AppKitHandle = {
  readonly config: Config;
  /** Opens the connect modal. */
  readonly open: () => void;
  /** Stops following the page's theme. */
  readonly dispose: () => void;
};

/** The font stack of the page (the `.zb` frame in bridge.css). */
export const PAGE_FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';

/** The accent of the page's Ember theme, used when the page has no computed value yet. */
export const FALLBACK_ACCENT = "#eb6834";

/** The accent token of the page (`--zb-accent`), as the colour it resolves to now. */
export const pageAccent = (): string => {
  const value = getComputedStyle(document.documentElement).getPropertyValue("--zb-accent").trim();
  return value === "" ? FALLBACK_ACCENT : value;
};

/** The theme mode of the page: the dapp puts `dark` on the root element when it draws dark colours. */
export const pageThemeMode = (): "dark" | "light" => (document.documentElement.classList.contains("dark") ? "dark" : "light");

/** The variables that make the modal look like the page: its accent, square corners, its font. */
export const pageThemeVariables = () => ({
  "--w3m-accent": pageAccent(),
  "--w3m-border-radius-master": "0px",
  "--w3m-font-family": PAGE_FONT,
});

/**
 * Creates the AppKit modal with the wagmi adapter. Everything that talks to Reown beyond the wallet relay is off:
 * analytics, email and social login, swaps, on-ramp, history, send and receive.
 *
 * @param options The project id, the chains and their transports.
 */
export const loadAppKit = async (options: AppKitOptions): Promise<AppKitHandle> => {
  const [{ createAppKit }, { WagmiAdapter }] = await Promise.all([import("@reown/appkit"), import("@reown/appkit-adapter-wagmi")]);
  const adapter = new WagmiAdapter({ projectId: options.projectId, networks: [...options.chains], transports: options.transports, ssr: false });
  const modal = createAppKit({
    adapters: [adapter],
    projectId: options.projectId,
    networks: [...options.chains],
    metadata: { name: "zkb.fi", description: "Bridge between Ethereum and PulseChain with zero-knowledge proofs.", url: window.location.origin, icons: [new URL("./favicon-32.png", document.baseURI).href] },
    features: { analytics: false, email: false, socials: false, swaps: false, onramp: false, history: false, send: false, receive: false },
    themeMode: pageThemeMode(),
    themeVariables: pageThemeVariables(),
  });
  // The modal follows the page: the theme classes on the root element change when the viewer picks another theme.
  const observer = new MutationObserver(() => {
    modal.setThemeMode(pageThemeMode());
    modal.setThemeVariables(pageThemeVariables());
  });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return { config: adapter.wagmiConfig, open: () => void modal.open(), dispose: () => observer.disconnect() };
};
