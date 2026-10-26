import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SettingsDialog } from "../../src/app/SettingsDialog";
import { buildTestServices } from "../render";
import { disconnectedWallet, renderWithWallet } from "./support";

const liveServices = (rpcUrls: Record<number, string>, indexerUrl: string) => {
  const base = buildTestServices();
  return { configuration: { ...base.configuration, dataMode: "live" as const, indexerUrl, rpcUrls } };
};

const renderSettings = (services = {}) =>
  renderWithWallet(<SettingsDialog theme="system" onTheme={() => undefined} onRecentCleared={() => undefined} onClose={() => undefined} />, { wallet: disconnectedWallet(), services });

describe("the settings of a live page", () => {
  it("shows only the host of the indexer and of each RPC address, never a path or a key", () => {
    renderSettings(liveServices({ 1: "https://eth.example.org/v2/secret-path", 369: "https://pls.example.org:8545/key" }, "https://indexer.example.org/api"));
    const dialog = screen.getByRole("dialog", { name: "Settings" });
    expect(within(dialog).getByText("Data").nextSibling).toHaveTextContent("live");
    expect(within(dialog).getByText("Indexer").nextSibling).toHaveTextContent("indexer.example.org");
    expect(within(dialog).getByText("Ethereum RPC").nextSibling).toHaveTextContent("eth.example.org");
    expect(within(dialog).getByText("PulseChain RPC").nextSibling).toHaveTextContent("pls.example.org:8545");
    expect(dialog).not.toHaveTextContent("secret-path");
    expect(dialog).not.toHaveTextContent("/key");
  });

  it("says that an RPC address is not set, and that an address is not valid", () => {
    renderSettings(liveServices({ 369: "not a url" }, "also not a url"));
    const dialog = screen.getByRole("dialog", { name: "Settings" });
    expect(within(dialog).getByText("Ethereum RPC").nextSibling).toHaveTextContent("not set");
    expect(within(dialog).getByText("PulseChain RPC").nextSibling).toHaveTextContent("not a valid URL");
    expect(within(dialog).getByText("Indexer").nextSibling).toHaveTextContent("not a valid URL");
  });
});

describe("the settings of a live page without an indexer variable", () => {
  it("says default for the indexer, because the registry default decides", () => {
    const base = buildTestServices();
    renderSettings({ configuration: { ...base.configuration, dataMode: "live" as const, indexerUrl: null, rpcUrls: {} } });
    expect(within(screen.getByRole("dialog", { name: "Settings" })).getByText("Indexer").nextSibling).toHaveTextContent("default");
  });
});

describe("the link to the connections page", () => {
  it("points at the settings route and closes the dialog when it is used", async () => {
    const onClose = vi.fn();
    renderWithWallet(<SettingsDialog theme="system" onTheme={() => undefined} onRecentCleared={() => undefined} onClose={onClose} />, { wallet: disconnectedWallet() });
    const link = screen.getByRole("link", { name: "Connections: indexer and RPC URLs" });
    expect(link).toHaveAttribute("href", "#/settings");
    await userEvent.click(link);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("the settings of a fixture page", () => {
  it("says that the indexer is none and that nothing reaches a network", () => {
    renderSettings();
    const dialog = screen.getByRole("dialog", { name: "Settings" });
    expect(within(dialog).getByText("Indexer").nextSibling).toHaveTextContent("none");
    expect(within(dialog).getByText("Data").nextSibling).toHaveTextContent("sample data, nothing reaches a network");
  });
});

describe("the controls of the settings", () => {
  it("passes the chosen theme to the handler, and marks the current one as pressed", async () => {
    const onTheme = vi.fn();
    renderWithWallet(<SettingsDialog theme="dark" onTheme={onTheme} onRecentCleared={() => undefined} onClose={() => undefined} />, { wallet: disconnectedWallet() });
    expect(screen.getByRole("button", { name: "Dark" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Light" })).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(screen.getByRole("button", { name: "Follow the system" }));
    expect(onTheme).toHaveBeenCalledWith("system");
  });

  it("empties the stored list, then tells the page", async () => {
    window.localStorage.setItem("zk-bridge-explorer.recent", '[{"id":"x"}]');
    const onRecentCleared = vi.fn();
    renderWithWallet(<SettingsDialog theme="system" onTheme={() => undefined} onRecentCleared={onRecentCleared} onClose={() => undefined} />, { wallet: disconnectedWallet() });
    await userEvent.click(screen.getByRole("button", { name: "Clear the recent list" }));
    expect(window.localStorage.getItem("zk-bridge-explorer.recent")).toBe("[]");
    expect(onRecentCleared).toHaveBeenCalledTimes(1);
  });
});
