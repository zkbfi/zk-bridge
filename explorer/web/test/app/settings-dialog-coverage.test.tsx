import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionStorage } from "../../src/config/connection-storage";
import { CONNECTION_STORAGE_KEY } from "../../src/config/connection-storage";
import { SettingsDialog, hostOf, keptNotice } from "../../src/app/SettingsDialog";
import type { Prober } from "../../src/app/service-probe";
import type { Services } from "../../src/app/services";
import { loadFeeCap, loadHardCap } from "../../src/bridge/fee-cap";
import { FIRST_CHAIN, SECOND_CHAIN, liveServices } from "../support/live";
import { disconnectedWallet, renderWithWallet } from "./support";

beforeEach(() => window.localStorage.clear());

const memoryStorage = (): ConnectionStorage & { readonly items: Map<string, string> } => {
  const items = new Map<string, string>();
  return { items, getItem: (key) => items.get(key) ?? null, setItem: (key, value) => void items.set(key, value) };
};

const stored = (storage: ReturnType<typeof memoryStorage>) => JSON.parse(storage.items.get(CONNECTION_STORAGE_KEY) ?? "null");

type Options = { readonly services?: Partial<Services>; readonly storage?: ConnectionStorage | null; readonly location?: { protocol: string; hostname: string; pathname: string }; readonly onTheme?: (theme: string) => void; readonly onClose?: () => void; readonly onRecentCleared?: () => void };

const renderSettings = (options: Options = {}) => {
  const memory = memoryStorage();
  const storage = options.storage === undefined ? memory : options.storage;
  renderWithWallet(
    <SettingsDialog theme="dark" onTheme={options.onTheme ?? (() => undefined)} onRecentCleared={options.onRecentCleared ?? (() => undefined)} onClose={options.onClose ?? (() => undefined)} storage={storage} {...(options.location === undefined ? {} : { location: options.location })} />,
    { wallet: disconnectedWallet(), ...(options.services === undefined ? {} : { services: options.services }) },
  );
  return { dialog: screen.getByRole("dialog", { name: "Settings" }), storage: memory };
};

const field = (name: string) => screen.getByRole("textbox", { name });
const save = () => userEvent.click(screen.getByRole("button", { name: "Save" }));

describe("the msgboard nodes in Settings (owner, quote 87)", () => {
  it("shows one node per chain with its icon, and checks a shared URL twice, once per chain, each with its own result", async () => {
    const calls: string[] = [];
    const probe: Prober = async (url, kind) => {
      calls.push(`${url} ${kind.kind} ${"chainId" in kind ? kind.chainId : "-"}`);
      return kind.kind === "jsonrpc" && "chainId" in kind && kind.chainId === SECOND_CHAIN ? { ok: false, reason: "No answer." } : { ok: true, ms: 4 };
    };
    renderSettings({ services: { probe } });
    expect(screen.getByRole("heading", { name: "Msgboard nodes" })).toBeInTheDocument();
    for (const name of ["Ethereum msgboard node", "PulseChain msgboard node"]) {
      await userEvent.clear(field(name));
      await userEvent.type(field(name), "https://board.example.org");
    }
    await waitFor(() => expect(calls.filter((call) => call.startsWith("https://board.example.org jsonrpc"))).toEqual(expect.arrayContaining([`https://board.example.org jsonrpc ${FIRST_CHAIN}`, `https://board.example.org jsonrpc ${SECOND_CHAIN}`])), { timeout: 3000 });
    await waitFor(() => expect(screen.getByRole("status", { name: /^Ethereum msgboard node: ok/ })).toBeInTheDocument());
    expect(screen.getByRole("status", { name: "PulseChain msgboard node: down" })).toBeInTheDocument();
  });

  it("moves a saved single node to both chains, and saves each chain on its own", async () => {
    const storage = memoryStorage();
    storage.setItem(CONNECTION_STORAGE_KEY, JSON.stringify({ indexerUrl: null, rpcUrls: {}, msgboardUrl: "https://old.example.org" }));
    renderSettings({ storage });
    expect(field("Ethereum msgboard node")).toHaveValue("https://old.example.org");
    expect(field("PulseChain msgboard node")).toHaveValue("https://old.example.org");
    await userEvent.clear(field("PulseChain msgboard node"));
    await userEvent.type(field("PulseChain msgboard node"), "https://pls.example.org");
    await save();
    await waitFor(() => expect(stored(storage).msgboardUrls).toEqual({ [FIRST_CHAIN]: "https://old.example.org", [SECOND_CHAIN]: "https://pls.example.org" }));
    expect(stored(storage).msgboardUrl).toBeNull();
  });
});

describe("the settings sheet", () => {
  it("has the sections of the mockup, in its order, and Reset to defaults before Save", () => {
    const { dialog } = renderSettings();
    expect(within(dialog).getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent)).toEqual(["Theme", "RPC endpoints", "Token and chain images", "Services", "Msgboard nodes", "More"]);
    expect(within(dialog).getByText("Used to read balances and send transactions. Yours stay in this browser.")).toBeInTheDocument();
    const buttons = within(dialog).getAllByRole("button").map((button) => button.textContent);
    expect(buttons.slice(-2)).toEqual(["Reset to defaults", "Save"]);
    expect(within(dialog).getByText("Sample data: nothing here reaches a network.")).toBeInTheDocument();
  });

  it("sets the theme from a segmented control and marks the current one", async () => {
    const onTheme = vi.fn();
    renderSettings({ onTheme });
    expect(screen.getByRole("radio", { name: "Dark" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "Mono" })).toHaveAttribute("aria-checked", "false");
    await userEvent.click(screen.getByRole("radio", { name: "System" }));
    expect(onTheme).toHaveBeenCalledWith("system");
  });

  it("shows each RPC and service with its default and a live check with the latency", async () => {
    renderSettings();
    expect(field("Ethereum RPC")).toHaveValue(`https://one.valve.city/rpc/vk_demo/evm/${FIRST_CHAIN}`);
    expect(field("Indexer")).toHaveValue("http://localhost:42069");
    expect(field("Prover")).toHaveValue("");
    expect(await screen.findByRole("status", { name: /^Ethereum RPC: ok, \d+ ms$/ })).toBeInTheDocument();
    expect(await screen.findByRole("status", { name: "Image server: ok, ok" })).toBeInTheDocument();
    expect(screen.queryByRole("status", { name: /^Prover/ })).toBeNull();
  });

  it("shows a red dot and down when a service does not answer", async () => {
    const probe: Prober = async () => ({ ok: false, reason: "The server answered /health with 404: check the address." });
    renderSettings({ services: { probe } });
    const check = await screen.findByRole("status", { name: "Indexer: down" });
    expect(check).toHaveAttribute("data-ok", "false");
    expect(check).toHaveAttribute("title", "The server answered /health with 404: check the address.");
  });

  it("saves a new RPC once it serves its chain, and keeps it in this browser", async () => {
    const { storage } = renderSettings();
    await userEvent.clear(field("PulseChain RPC"));
    await userEvent.type(field("PulseChain RPC"), "https://rpc.example.org/pls");
    await save();
    expect(await screen.findByText("Saved.")).toBeInTheDocument();
    expect(stored(storage).rpcUrls).toEqual({ [SECOND_CHAIN]: "https://rpc.example.org/pls" });
  });

  it("refuses an RPC of another chain, and stores nothing", async () => {
    const probe: Prober = async (_url, kind) => (kind.kind === "rpc" ? { ok: false, reason: "The node is on chain 1, not chain 369." } : { ok: true, ms: 5 });
    const storage = memoryStorage();
    renderSettings({ services: { probe }, storage });
    await userEvent.clear(field("PulseChain RPC"));
    await userEvent.type(field("PulseChain RPC"), "https://rpc.example.org/eth");
    await save();
    expect(await screen.findByText("Not saved. The node is on chain 1, not chain 369.")).toBeInTheDocument();
    expect(screen.getByText("Not saved: fix the marked fields.")).toBeInTheDocument();
    expect(storage.items.size).toBe(0);
  });

  it("marks a service URL it cannot use, and clears the mark on the next key", async () => {
    renderSettings();
    await userEvent.type(field("Archive"), "https://a.example.org/?key=1");
    await save();
    expect(screen.getByRole("alert")).toHaveTextContent("The URL must not hold a query or a fragment.");
    expect(field("Archive")).toHaveAttribute("aria-invalid", "true");
    await userEvent.type(field("Archive"), "x");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("resets one field to its default, or every field at once", async () => {
    renderSettings();
    await userEvent.clear(field("Indexer"));
    await userEvent.type(field("Indexer"), "https://mine.example.org");
    await userEvent.click(screen.getByRole("button", { name: "Reset Indexer" }));
    expect(field("Indexer")).toHaveValue("http://localhost:42069");
    expect(screen.queryByRole("button", { name: "Reset Indexer" })).toBeNull();
    await userEvent.type(field("Prover"), "https://prove.example.org");
    await userEvent.clear(field("Automatic fee cap (%)"));
    await userEvent.type(field("Automatic fee cap (%)"), "3");
    await userEvent.clear(field("Hard fee cap (%)"));
    await userEvent.type(field("Hard fee cap (%)"), "4");
    await userEvent.click(screen.getByRole("button", { name: "Reset to defaults" }));
    expect(field("Hard fee cap (%)")).toHaveValue("2");
    expect(field("Prover")).toHaveValue("");
    expect(field("Automatic fee cap (%)")).toHaveValue("1");
    expect(screen.getByText("Defaults filled in. Save to keep them.")).toBeInTheDocument();
  });

  it("shows a URL that looks like it holds a key masked until the field is in use", async () => {
    const storage = memoryStorage();
    storage.setItem(CONNECTION_STORAGE_KEY, JSON.stringify({ indexerUrl: null, rpcUrls: { [FIRST_CHAIN]: "https://rpc.example.org/v3/0123456789abcdef0123456789abcdef" } }));
    renderSettings({ storage });
    expect(field("Ethereum RPC")).not.toHaveValue("https://rpc.example.org/v3/0123456789abcdef0123456789abcdef");
    await userEvent.click(field("Ethereum RPC"));
    expect(field("Ethereum RPC")).toHaveValue("https://rpc.example.org/v3/0123456789abcdef0123456789abcdef");
  });

  it("saves the fee cap with the rest, and refuses one out of range", async () => {
    renderSettings();
    await userEvent.clear(field("Automatic fee cap (%)"));
    await userEvent.type(field("Automatic fee cap (%)"), "200");
    await save();
    expect(screen.getByRole("alert")).toHaveTextContent("Use a number above 0 and at most 100.");
    expect(loadFeeCap()).toBe(1);
    // Above the 2% hard cap it is refused; with the hard cap raised beside it, both save.
    await userEvent.clear(field("Automatic fee cap (%)"));
    await userEvent.type(field("Automatic fee cap (%)"), "2.5");
    await save();
    expect(screen.getByRole("alert")).toHaveTextContent("The automatic cap can't be above the 2% hard cap.");
    expect(loadFeeCap()).toBe(1);
    await userEvent.clear(field("Hard fee cap (%)"));
    await userEvent.type(field("Hard fee cap (%)"), "3");
    await save();
    await waitFor(() => expect(loadFeeCap()).toBe(2.5));
    expect(loadHardCap()).toBe(3);
  });

  it("shows each cap's number right-justified against its unit, and refuses a hard cap out of range", async () => {
    renderSettings();
    for (const name of ["Automatic fee cap (%)", "Hard fee cap (%)"]) {
      expect(field(name).nextElementSibling).toHaveTextContent(/^% of the amount$/);
      expect(field(name).closest(".zb-fld")).toHaveClass("zb-fld-cap");
    }
    expect(field("Hard fee cap (%)")).toHaveValue("2");
    await userEvent.clear(field("Hard fee cap (%)"));
    await userEvent.type(field("Hard fee cap (%)"), "0");
    await save();
    expect(screen.getByRole("alert")).toHaveTextContent("Use a number above 0 and at most 100.");
    expect(loadHardCap()).toBe(2);
  });

  it("clears the recent searches, and links to the connections page", async () => {
    window.localStorage.setItem("zk-bridge-explorer.recent", '[{"id":"x"}]');
    const onRecentCleared = vi.fn();
    const onClose = vi.fn();
    renderSettings({ onRecentCleared, onClose });
    await userEvent.click(screen.getByRole("button", { name: "Clear recent searches" }));
    expect(window.localStorage.getItem("zk-bridge-explorer.recent")).toBe("[]");
    expect(onRecentCleared).toHaveBeenCalledTimes(1);
    const link = screen.getByRole("link", { name: "Connections and fallback" });
    expect(link).toHaveAttribute("href", "#/settings");
    await userEvent.click(link);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("says when the browser did not keep the settings", async () => {
    renderSettings({ storage: null });
    await userEvent.type(field("Archive"), "https://a.example.org");
    await save();
    expect(await screen.findByText(/Saved\. The browser did not keep your settings/)).toBeInTheDocument();
  });
});

describe("the settings of a live page", () => {
  it("shows the deployment's defaults and puts a saved setting in use at once, with the plain-http warning", async () => {
    const live = liveServices({ storage: null });
    const apply = vi.spyOn(live.connection!, "apply");
    const probe: Prober = async () => ({ ok: true, ms: 7 });
    const storage = memoryStorage();
    renderSettings({ services: { ...live, probe }, storage });
    expect(field("PulseChain RPC")).toHaveValue("https://registry.example.org/pls");
    await userEvent.type(field("Prover"), "http://prove.example.org");
    await save();
    expect(apply).toHaveBeenCalledWith(expect.objectContaining({ backendUrl: "http://prove.example.org" }));
    expect(stored(storage).backendUrl).toBe("http://prove.example.org");
  });
});

describe("a live page's RPC check and an https page", () => {
  it("removes the URL from the reason an RPC was refused", async () => {
    const live = liveServices({ storage: null });
    const probe: Prober = async (url, kind) => (kind.kind === "rpc" ? { ok: false, reason: `eth_chainId did not complete: ${url} refused` } : { ok: true, ms: 3 });
    renderSettings({ services: { ...live, probe } });
    await userEvent.clear(field("Ethereum RPC"));
    await userEvent.type(field("Ethereum RPC"), "https://rpc.example.org/v3/secretkeyvalue");
    await save();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/^Not saved\. eth_chainId did not complete:/);
    expect(alert).not.toHaveTextContent("secretkeyvalue");
  });

  it("warns that the browser blocks a plain-http service on an https page, and says when a gateway shares the origin", async () => {
    renderSettings({ location: { protocol: "https:", hostname: "gateway.example.org", pathname: "/ipfs/bafy/" } });
    expect(screen.getByText("This gateway is shared with other sites, so settings last for this visit only.")).toBeInTheDocument();
    await userEvent.type(field("Archive"), "http://a.example.org");
    await save();
    expect(await screen.findByText(/^Saved\. Saved, but this page uses https/)).toBeInTheDocument();
  });
});

describe("the note after a save", () => {
  it("says nothing when the browser kept everything, and why otherwise", () => {
    expect(keptNotice("stored")).toBeNull();
    expect(keptNotice("shared-origin")).toMatch(/this visit only/);
    expect(keptNotice("key-like-url")).toMatch(/looks like it holds a key/);
    expect(keptNotice("no-storage")).toMatch(/did not keep/);
  });
});

describe("the host of an endpoint", () => {
  it("shows the host only, or says the text is not a URL", () => {
    expect(hostOf("https://eth.example.org/v2/secret")).toBe("eth.example.org");
    expect(hostOf("nope")).toBe("not a valid URL");
  });
});
