import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getAddress } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FIXTURE_ACCOUNT, FIXTURE_PAIR, FIXTURE_TOKENS } from "@terminal/data/fixtures";
import { Shell } from "../../src/app/Shell";
import { RECENT_STORAGE_KEY } from "../../src/search/recent-items";
import { buildTestServices } from "../render";
import { connectedWallet, disconnectedWallet, renderWithWallet } from "./support";

beforeEach(() => {
  window.location.hash = "";
  window.localStorage.clear();
  document.documentElement.className = "";
  document.title = "";
});

/** Opens the palette with the keyboard, types the text and presses Enter on the first result. */
const chooseFromPalette = async (text: string) => {
  await userEvent.keyboard("{Control>}k{/Control}");
  const input = await screen.findByRole("combobox");
  await userEvent.click(input);
  await userEvent.paste(text);
  await userEvent.keyboard("{Enter}");
};

describe("the shell keyboard shortcut", () => {
  it("opens the palette on the slash key when the event has no element as its target", async () => {
    renderWithWallet(<Shell />, { wallet: disconnectedWallet() });
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "/", bubbles: true, cancelable: true }));
    });
    expect(await screen.findByRole("dialog", { name: "Search and jump" })).toBeInTheDocument();
  });

  it("ignores a key that is neither the chord nor the slash", async () => {
    renderWithWallet(<Shell />, { wallet: disconnectedWallet() });
    await userEvent.keyboard("a");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("the shell routes", () => {
  it("shows the pair view for the pair route, and the title of the page follows the route", async () => {
    window.location.hash = `#/pair/${FIXTURE_PAIR.id}`;
    renderWithWallet(<Shell />, { wallet: disconnectedWallet() });
    expect(await screen.findByRole("table", { name: "Transfers and messages" })).toBeInTheDocument();
    expect(screen.getByLabelText("Token")).toHaveValue("all");
    expect(document.title).toBe("Pair view · zk-bridge explorer");
  });

  it("keys the pair view by the token of the route, so a new token starts a new view", async () => {
    const weth = FIXTURE_TOKENS[2]!;
    window.location.hash = `#/pair/${FIXTURE_PAIR.id}?token=${weth.address}`;
    renderWithWallet(<Shell />, { wallet: disconnectedWallet() });
    expect(await screen.findByRole("table", { name: "Transfers and messages" })).toBeInTheDocument();
    expect(screen.getByLabelText("Token")).toHaveValue(weth.address);
  });

  it("shows the address view for the address route", async () => {
    window.location.hash = `#/address/${FIXTURE_ACCOUNT}`;
    renderWithWallet(<Shell />, { wallet: disconnectedWallet() });
    expect(await screen.findByText(getAddress(FIXTURE_ACCOUNT))).toBeInTheDocument();
    expect(document.title).toBe("Address · zk-bridge explorer");
  });

  it("follows a change of the address bar", async () => {
    renderWithWallet(<Shell />, { wallet: disconnectedWallet() });
    expect(await screen.findByRole("heading", { name: "Global view" })).toBeInTheDocument();
    act(() => {
      window.location.hash = "#/audit";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(await screen.findByRole("heading", { name: "Audit" })).toBeInTheDocument();
  });
});

describe("the shell banner", () => {
  it("warns about sample data on a fixture page", () => {
    renderWithWallet(<Shell />, { wallet: disconnectedWallet() });
    expect(screen.getByText("Sample data. Nothing here is real and no send reaches a chain.")).toBeInTheDocument();
  });

  it("shows no sample banner on a live page", () => {
    const base = buildTestServices();
    renderWithWallet(<Shell />, { wallet: disconnectedWallet(), services: { configuration: { ...base.configuration, dataMode: "live" } } });
    expect(screen.queryByText(/Sample data/)).toBeNull();
  });

  it("says TESTNET on every page of a testnet pair, and nothing on the mainnet pair", () => {
    const base = buildTestServices();
    const { unmount } = renderWithWallet(<Shell />, {
      wallet: disconnectedWallet(),
      services: { configuration: { ...base.configuration, dataMode: "live", pairName: "sepolia-pls943" } },
    });
    expect(screen.getByText("Testnet: Sepolia and PulseChain testnet v4. Test coins only; nothing here has real value.")).toBeInTheDocument();
    unmount();
    renderWithWallet(<Shell />, { wallet: disconnectedWallet(), services: { configuration: { ...base.configuration, dataMode: "live", pairName: "eth-pls" } } });
    expect(screen.queryByText(/^Testnet:/)).toBeNull();
  });

  it("shows the short account of a connected wallet and No wallet otherwise", () => {
    const { unmount } = renderWithWallet(<Shell />, { wallet: connectedWallet() });
    expect(screen.getByText(`${FIXTURE_ACCOUNT.slice(0, 6)}…${FIXTURE_ACCOUNT.slice(-4)}`)).toBeInTheDocument();
    unmount();
    renderWithWallet(<Shell />, { wallet: disconnectedWallet() });
    expect(screen.getByText("No wallet")).toBeInTheDocument();
  });
});

describe("the wallet actions of the palette", () => {
  it("shows the message of a wallet that refuses to connect, and the viewer can dismiss it", async () => {
    const connect = vi.fn().mockRejectedValue(new Error("The viewer closed the wallet."));
    renderWithWallet(<Shell />, { wallet: disconnectedWallet({ connect }) });
    await chooseFromPalette("connect a wallet");
    expect(await screen.findByText("The viewer closed the wallet.")).toBeInTheDocument();
    expect(connect).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText("The viewer closed the wallet.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
  });

  it("shows the text of a refusal that is not an error object", async () => {
    renderWithWallet(<Shell />, { wallet: disconnectedWallet({ connect: () => Promise.reject("plain refusal") }) });
    await chooseFromPalette("connect a wallet");
    expect(await screen.findByText("plain refusal")).toBeInTheDocument();
  });

  it("disconnects the wallet from the action of a connected wallet", async () => {
    const disconnect = vi.fn();
    renderWithWallet(<Shell />, { wallet: connectedWallet({ disconnect }) });
    await chooseFromPalette("disconnect the wallet");
    await waitFor(() => expect(disconnect).toHaveBeenCalledTimes(1));
  });

  it("switches the wallet to the chain that the action names", async () => {
    const switchChain = vi.fn().mockResolvedValue(undefined);
    renderWithWallet(<Shell />, { wallet: connectedWallet({ switchChain }) });
    await chooseFromPalette("switch the wallet to pulsechain");
    await waitFor(() => expect(switchChain).toHaveBeenCalledWith(FIXTURE_PAIR.second.chainId));
    expect(switchChain).toHaveBeenCalledTimes(1);
  });
});

describe("the dialogs of the shell", () => {
  it("closes a form dialog with Escape", async () => {
    renderWithWallet(<Shell />, { wallet: disconnectedWallet() });
    await chooseFromPalette("bridge tokens");
    expect(await screen.findByRole("dialog", { name: "Bridge tokens" })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("opens the dialog that a button of the pair view asks for, through the actions port of the shell", async () => {
    window.location.hash = `#/pair/${FIXTURE_PAIR.id}`;
    renderWithWallet(<Shell />, { wallet: connectedWallet() });
    await userEvent.click(await screen.findByRole("button", { name: "Send a message" }));
    expect(await screen.findByRole("dialog", { name: "Send a message" })).toBeInTheDocument();
  });

  it("closes the settings, and clears the recent list from there", async () => {
    renderWithWallet(<Shell />, { wallet: disconnectedWallet() });
    await chooseFromPalette("audit");
    await waitFor(() => expect(window.location.hash).toBe("#/audit"));
    expect(window.localStorage.getItem(RECENT_STORAGE_KEY)).toContain("view:audit");

    await chooseFromPalette("settings");
    const settings = await screen.findByRole("dialog", { name: "Settings" });
    await userEvent.click(within(settings).getByRole("button", { name: "Clear the recent list" }));
    expect(window.localStorage.getItem(RECENT_STORAGE_KEY)).toBe("[]");

    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull());

    await userEvent.keyboard("{Control>}k{/Control}");
    await screen.findByRole("combobox");
    expect(screen.queryByText("Recent")).toBeNull();
  });

  it("changes the theme from the settings", async () => {
    renderWithWallet(<Shell />, { wallet: disconnectedWallet() });
    await chooseFromPalette("settings");
    const settings = await screen.findByRole("dialog", { name: "Settings" });
    await userEvent.click(within(settings).getByRole("button", { name: "Dark" }));
    await waitFor(() => expect(document.documentElement).toHaveClass("dark"));
    expect(within(settings).getByRole("button", { name: "Dark" })).toHaveAttribute("aria-pressed", "true");
  });
});
