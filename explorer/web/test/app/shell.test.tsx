import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { Shell } from "../../src/app/Shell";
import { renderPage } from "../render";

beforeEach(() => {
  // These tests start on the table of all pairs; the landing on the default pair has its own tests.
  window.location.hash = "#/pairs";
  window.localStorage.clear();
  document.documentElement.className = "";
});

const searchFor = async (text: string) => {
  await userEvent.keyboard("{Control>}k{/Control}");
  const input = await screen.findByRole("combobox");
  await userEvent.click(input);
  await userEvent.paste(text);
  return input;
};

describe("the shell: the history page", () => {
  it("opens the history from the top bar and keeps the filters in the address", async () => {
    renderPage(<Shell />, { connected: false });
    await userEvent.click(screen.getByRole("link", { name: "History" }));
    expect(await screen.findByRole("heading", { name: "History" })).toBeInTheDocument();
    expect(window.location.hash).toBe("#/history");
    await userEvent.selectOptions(screen.getByLabelText("Chain"), "369");
    await waitFor(() => expect(window.location.hash).toBe("#/history?chain=369"));
    expect(screen.getByLabelText("Chain")).toHaveValue("369");
  });
});

describe("the shell: one search field instead of a menu", () => {
  it("has a search button in the top bar and no navigation menu", async () => {
    renderPage(<Shell />, { connected: false });
    expect(screen.getByRole("button", { name: /Search and jump/ })).toBeInTheDocument();
    expect(screen.queryByRole("navigation")).toBeNull();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByRole("heading", { name: "Global view" })).toBeInTheDocument();
  });

  it("opens the palette with Control K, with Command K and with the slash key", async () => {
    renderPage(<Shell />, { connected: false });
    await userEvent.keyboard("{Control>}k{/Control}");
    expect(await screen.findByRole("dialog", { name: "Search and jump" })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await userEvent.keyboard("{Meta>}k{/Meta}");
    expect(await screen.findByRole("dialog", { name: "Search and jump" })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await userEvent.keyboard("/");
    expect(await screen.findByRole("dialog", { name: "Search and jump" })).toBeInTheDocument();
  });

  it("does not open on the slash key while the viewer types in a field", async () => {
    renderPage(<Shell />, { connected: false });
    await userEvent.click(screen.getByRole("button", { name: /Search and jump/ }));
    const input = await screen.findByRole("combobox");
    await userEvent.type(input, "a/b");
    expect(input).toHaveValue("a/b");
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
  });

  it("jumps to a view and puts it in the address bar", async () => {
    renderPage(<Shell />, { connected: false });
    await searchFor("prover");
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(window.location.hash).toBe("#/prover"));
    expect(await screen.findByRole("heading", { name: "Prover and costs" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("jumps to a documentation heading and shows that page", async () => {
    renderPage(<Shell />, { connected: false });
    await searchFor("data source of each number");
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(window.location.hash).toBe("#/docs/fees-explained/the-data-source-of-each-number"));
    const article = await screen.findByRole("article", { name: "Fees explained" });
    expect(within(article).getByRole("heading", { name: "The data source of each number" })).toBeInTheDocument();
  });

  it("jumps to a transfer by message identifier", async () => {
    renderPage(<Shell />, { connected: false });
    const { buildFixtureFeed, FIXTURE_NOW } = await import("@terminal/data/fixtures");
    const item = buildFixtureFeed(FIXTURE_NOW)[0]!;
    await searchFor(item.id);
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(window.location.hash).toBe(`#/message/${item.id}`));
    expect(await screen.findByText("message ID", { exact: false })).toHaveTextContent(`${item.id.slice(0, 10)}…${item.id.slice(-4)}`);
  });

  it("opens the bridge dialog from an action and asks for a wallet when none is connected", async () => {
    renderPage(<Shell />, { connected: false });
    await searchFor("bridge tokens");
    await userEvent.keyboard("{Enter}");
    const dialog = await screen.findByRole("dialog", { name: "Bridge tokens" });
    expect(within(dialog).getByText(/Connect a wallet first/)).toBeInTheDocument();
  });

  it("connects the wallet from an action", async () => {
    renderPage(<Shell />, { connected: false });
    await searchFor("connect a wallet");
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(screen.getByText(/0x[0-9a-fA-F]{4}…[0-9a-fA-F]{4}/)).toBeInTheDocument());
  });

  it("changes the theme from an action and remembers it", async () => {
    renderPage(<Shell />, { connected: false });
    await searchFor("theme dark");
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(document.documentElement).toHaveClass("dark"));
    expect(window.localStorage.getItem("zk-bridge-explorer.theme")).toBe("dark");
  });

  it("opens the settings, which say that the sample page reaches no network", async () => {
    renderPage(<Shell />, { connected: false });
    await searchFor("settings");
    await userEvent.keyboard("{Enter}");
    const dialog = await screen.findByRole("dialog", { name: "Settings" });
    expect(within(dialog).getByText("Sample data: nothing here reaches a network.")).toBeInTheDocument();
  });

  it("opens the connections page from the palette, and keeps the settings action for the settings dialog", async () => {
    renderPage(<Shell />, { connected: false });
    await searchFor("connections");
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(window.location.hash).toBe("#/settings"));
    expect(await screen.findByRole("heading", { name: "Connections" })).toBeInTheDocument();
    expect(document.title).toBe("Connections · zk-bridge explorer");
    expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();
  });

  it("remembers what the user opened and offers it first the next time", async () => {
    renderPage(<Shell />, { connected: false });
    await searchFor("audit");
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(window.location.hash).toBe("#/audit"));
    await act(async () => {
      await userEvent.keyboard("{Control>}k{/Control}");
    });
    const groups = await screen.findAllByRole("group");
    expect(groups[0]).toHaveTextContent(/^Recent/);
    expect(groups[0]).toHaveTextContent("Audit");
  });

  it("returns focus to the search button when the palette closes", async () => {
    renderPage(<Shell />, { connected: false });
    const button = screen.getByRole("button", { name: /Search and jump/ });
    await userEvent.click(button);
    await screen.findByRole("combobox");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(button).toHaveFocus());
  });
});
