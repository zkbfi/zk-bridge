import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FIXTURE_PAIR } from "@terminal/data/fixtures";
import { FALLBACK_ACCENT, loadAppKit, pageAccent, pageThemeMode, pageThemeVariables, PAGE_FONT } from "../../src/wallet/appkit";
import { walletChains, walletTransports } from "../../src/wallet/wagmi-wallet";

const kit = vi.hoisted(() => {
  const modal = { open: vi.fn(), setThemeMode: vi.fn(), setThemeVariables: vi.fn() };
  return { modal, createAppKit: vi.fn(() => modal), adapterOptions: [] as unknown[], wagmiConfig: { marker: "adapter-config" } };
});
vi.mock("@reown/appkit", () => ({ createAppKit: kit.createAppKit }));
vi.mock("@reown/appkit-adapter-wagmi", () => ({
  WagmiAdapter: class {
    wagmiConfig = kit.wagmiConfig;
    constructor(options: unknown) {
      kit.adapterOptions.push(options);
    }
  },
}));

const PROJECT_ID = "0123456789abcdef0123456789abcdef";
const options = () => {
  const chains = walletChains(FIXTURE_PAIR, { 1: "https://eth.example.org", 369: "https://pls.example.org" });
  return { projectId: PROJECT_ID, chains, transports: walletTransports(chains) };
};

beforeEach(() => {
  kit.createAppKit.mockClear();
  kit.modal.open.mockReset();
  kit.modal.setThemeMode.mockReset();
  kit.modal.setThemeVariables.mockReset();
  kit.adapterOptions.length = 0;
  document.documentElement.className = "";
  document.documentElement.style.removeProperty("--zb-accent");
});
afterEach(() => {
  document.documentElement.className = "";
  document.documentElement.style.removeProperty("--zb-accent");
});

describe("the look of the modal", () => {
  it("reads the accent token of the page, and falls back to the Ember accent when the page has none", () => {
    expect(pageAccent()).toBe(FALLBACK_ACCENT);
    document.documentElement.style.setProperty("--zb-accent", " #123456 ");
    expect(pageAccent()).toBe("#123456");
  });

  it("follows the dark class of the page", () => {
    expect(pageThemeMode()).toBe("light");
    document.documentElement.classList.add("dark");
    expect(pageThemeMode()).toBe("dark");
  });

  it("uses the accent, square corners and the font of the page", () => {
    expect(pageThemeVariables()).toEqual({ "--w3m-accent": FALLBACK_ACCENT, "--w3m-border-radius-master": "0px", "--w3m-font-family": PAGE_FONT });
  });
});

describe("loadAppKit", () => {
  it("creates the modal with the pair's chains and the page's transports, and with everything but the wallet list off", async () => {
    const given = options();
    const handle = await loadAppKit(given);
    expect(kit.adapterOptions).toEqual([{ projectId: PROJECT_ID, networks: given.chains, transports: given.transports, ssr: false }]);
    expect(kit.createAppKit).toHaveBeenCalledTimes(1);
    const created = (kit.createAppKit.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(created).toMatchObject({
      projectId: PROJECT_ID,
      networks: given.chains,
      features: { analytics: false, email: false, socials: false, swaps: false, onramp: false, history: false, send: false, receive: false },
      themeMode: "light",
      themeVariables: { "--w3m-accent": FALLBACK_ACCENT, "--w3m-border-radius-master": "0px", "--w3m-font-family": PAGE_FONT },
      metadata: { name: "zkb.fi", url: window.location.origin },
    });
    expect((created.networks as { id: number }[]).map((chain) => chain.id)).toEqual([1, 369]);
    expect(handle.config).toBe(kit.wagmiConfig);
    handle.dispose();
  });

  it("opens the modal", async () => {
    const handle = await loadAppKit(options());
    handle.open();
    expect(kit.modal.open).toHaveBeenCalledTimes(1);
    handle.dispose();
  });

  it("starts in the mode of the page, and follows the page when the theme changes, until it is disposed", async () => {
    document.documentElement.classList.add("dark");
    const handle = await loadAppKit(options());
    expect((kit.createAppKit.mock.calls[0] as unknown as [Record<string, unknown>])[0]).toMatchObject({ themeMode: "dark" });
    document.documentElement.classList.remove("dark");
    document.documentElement.style.setProperty("--zb-accent", "#abcdef");
    await vi.waitFor(() => expect(kit.modal.setThemeMode).toHaveBeenCalledWith("light"));
    expect(kit.modal.setThemeVariables).toHaveBeenLastCalledWith(expect.objectContaining({ "--w3m-accent": expect.any(String) }));
    handle.dispose();
    kit.modal.setThemeMode.mockReset();
    document.documentElement.classList.add("dark");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(kit.modal.setThemeMode).not.toHaveBeenCalled();
  });
});

describe("walletTransports", () => {
  it("builds one transport per chain on the chain's endpoint, and uses the local node for a chain with none", () => {
    const chains = walletChains(FIXTURE_PAIR, {});
    expect(Object.keys(walletTransports(chains))).toEqual(chains.map((chain) => String(chain.id)));
    expect(Object.keys(walletTransports([{ ...chains[0], rpcUrls: { default: { http: [] } } }]))).toEqual([String(chains[0].id)]);
  });
});
