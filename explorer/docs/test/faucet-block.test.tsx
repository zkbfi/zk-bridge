import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ServicesProvider, type Services } from "@web/app/services";
import { FAUCET_TOKEN_ADDRESS } from "@web/faucet/faucet-model";
import { WalletContext, type WalletPort } from "@web/wallet/wallet-port";
import { parseMarkdown } from "@web/docs/markdown";
import type { PairConfig } from "@terminal/model/types";
import { DocsMarkdown } from "../src/DocsMarkdown";
import { FaucetBlock } from "../src/FaucetBlock";
import DocsPage from "../src/DocsPage";

// The mint itself (the confirm dialog, the wallet switch) is tested with the hook in web/test/faucet; here it is a stand-in.
const mint = vi.hoisted(() => vi.fn());
vi.mock("@web/faucet/use-mint", () => ({ useMint: () => ({ mint, dialog: <div data-testid="dialog" /> }) }));

const chain = (side: "first" | "second", chainId: number, name: string) => ({ side, chainId, name });
const PAIR = { id: "sepolia-pls943", first: chain("first", 11155111, "Sepolia"), second: chain("second", 943, "PulseChain testnet v4") } as unknown as PairConfig;
const SERVICES = { pair: PAIR } as unknown as Services;

const wallet = (overrides: Partial<WalletPort> = {}): WalletPort => ({
  status: "connected",
  account: `0x${"12".repeat(20)}`,
  chainId: 11155111,
  walletName: "Test wallet",
  walletAvailable: true,
  kind: "real",
  connect: vi.fn(async () => undefined),
  disconnect: () => undefined,
  switchChain: async () => undefined,
  sendTransaction: async () => {
    throw new Error("not expected");
  },
  watchAsset: vi.fn(async () => undefined),
  ...overrides,
});

const inApp = (port: WalletPort, ui: ReactNode) =>
  render(
    <ServicesProvider services={SERVICES}>
      <WalletContext.Provider value={port}>{ui}</WalletContext.Provider>
    </ServicesProvider>,
  );

beforeEach(() => {
  mint.mockReset();
});

describe("FaucetBlock", () => {
  it("shows the token, its address and the one-mint amount, and mints on its own chain when the wallet is connected", () => {
    inApp(wallet(), <FaucetBlock chainId={943} />);
    expect(screen.getByRole("region", { name: "Mint tFAU on PulseChain testnet v4" })).toBeInTheDocument();
    expect(screen.getByText("zkb Faucet Token (tFAU), 18 decimals")).toBeInTheDocument();
    expect(screen.getByText(FAUCET_TOKEN_ADDRESS[943] as string)).toHaveClass("zd-code");
    expect(screen.getByText("1,000 tFAU, sent to your wallet")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Mint 1,000 tFAU" }));
    expect(mint).toHaveBeenCalledWith(943);
    expect(screen.getByTestId("dialog")).toBeInTheDocument();
  });

  it("says that minting switches the wallet when it is on another chain, and not when it is on this one", () => {
    const { unmount } = inApp(wallet({ chainId: 11155111 }), <FaucetBlock chainId={943} />);
    expect(screen.getByText("Your wallet is on another chain. Minting switches it to PulseChain testnet v4 first.")).toBeInTheDocument();
    unmount();
    inApp(wallet({ chainId: 943 }), <FaucetBlock chainId={943} />);
    expect(screen.queryByText(/Minting switches it/)).toBeNull();
  });

  it("without a wallet shows the address and a Connect wallet button, and no mint", () => {
    const connect = vi.fn(async () => undefined);
    inApp(wallet({ status: "disconnected", account: null, chainId: null, walletName: null, connect }), <FaucetBlock chainId={11155111} />);
    expect(screen.getByText(FAUCET_TOKEN_ADDRESS[11155111] as string)).toBeInTheDocument();
    expect(screen.getByText("1,000 tFAU, sent to the wallet you connect")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Mint/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Add tFAU/ })).toBeNull();
    expect(screen.getByText(/Connect a wallet to mint/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Connect wallet" }));
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("asks the wallet to list the token on this chain, and says when it did", async () => {
    const watchAsset = vi.fn(async () => undefined);
    inApp(wallet({ watchAsset }), <FaucetBlock chainId={11155111} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Add tFAU to wallet" })));
    expect(watchAsset).toHaveBeenCalledWith({ chainId: 11155111, address: FAUCET_TOKEN_ADDRESS[11155111], symbol: "tFAU", decimals: 18 });
    expect(screen.getByRole("status")).toHaveTextContent("Your wallet lists tFAU on Sepolia.");
  });

  it("gives the wallet's reason, on one line, when it does not list the token", async () => {
    const watchAsset = vi.fn(async () => {
      throw new Error("User rejected the request.\nmore detail");
    });
    inApp(wallet({ watchAsset }), <FaucetBlock chainId={11155111} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Add tFAU to wallet" })));
    expect(screen.getByRole("status")).toHaveTextContent("Your wallet did not list tFAU: User rejected the request.");
    expect(screen.getByRole("status")).not.toHaveTextContent("more detail");
  });

  it("reads a refusal that is not an Error", async () => {
    const watchAsset = vi.fn(() => Promise.reject("declined"));
    inApp(wallet({ watchAsset }), <FaucetBlock chainId={11155111} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Add tFAU to wallet" })));
    expect(screen.getByRole("status")).toHaveTextContent("Your wallet did not list tFAU: declined");
  });

  it("draws nothing for a chain that is not in the pair", () => {
    const { container } = inApp(wallet(), <FaucetBlock chainId={1} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("is what a faucet block of a page draws", () => {
    inApp(wallet(), <DocsMarkdown blocks={parseMarkdown("```faucet\nchain: 11155111\n```")} />);
    expect(screen.getByRole("region", { name: "Mint tFAU on Sepolia" })).toBeInTheDocument();
  });
});

describe("the Get testnet tokens page", () => {
  it("is not found on a pair that is not the testnet pair, and the front page does not list it", () => {
    const { unmount } = render(<DocsPage slug="get-testnet-tokens" heading={null} chainIds={[1, 369]} />);
    expect(screen.getByRole("heading", { level: 1, name: "Not found" })).toBeInTheDocument();
    unmount();
    render(<DocsPage slug={null} heading={null} chainIds={[1, 369]} />);
    expect(screen.queryByRole("link", { name: /Get testnet tokens/ })).toBeNull();
  });

  it("is not found when the app passes no chains", () => {
    render(<DocsPage slug="get-testnet-tokens" heading={null} />);
    expect(screen.getByRole("heading", { level: 1, name: "Not found" })).toBeInTheDocument();
  });

  it("on the testnet pair opens the gas faucets in new tabs, a mint block for each chain, and the way to bridge", () => {
    inApp(wallet(), <DocsPage slug="get-testnet-tokens" heading={null} chainIds={[11155111, 943]} />);
    expect(screen.getByRole("heading", { level: 1, name: "Get testnet tokens" })).toBeInTheDocument();
    for (const [name, href] of [
      ["Sepolia proof-of-work faucet", "https://sepolia-faucet.pk910.de/"],
      ["PulseChain testnet v4 faucet", "https://faucet.v4.testnet.pulsechain.com/"],
    ] as const) {
      const link = screen.getByRole("link", { name });
      expect(link).toHaveAttribute("href", href);
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noopener noreferrer");
    }
    expect(screen.getByText(/it mines in the browser tab/)).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Mint tFAU on Sepolia" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Mint tFAU on PulseChain testnet v4" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Step 3: bridge it" })).toBeInTheDocument();
  });

  it("is linked from Getting started, which a mainnet pair shows as plain text", () => {
    const { unmount } = render(<DocsPage slug="getting-started" heading={null} chainIds={[11155111, 943]} />);
    expect(screen.getByRole("link", { name: "Get testnet tokens" })).toHaveAttribute("href", "#/docs/get-testnet-tokens");
    unmount();
    render(<DocsPage slug="getting-started" heading={null} chainIds={[1, 369]} />);
    expect(screen.queryByRole("link", { name: "Get testnet tokens" })).toBeNull();
  });
});
