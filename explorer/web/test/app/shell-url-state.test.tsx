import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { FIXTURE_PAIR } from "@terminal/data/fixtures";
import { Shell } from "../../src/app/Shell";
import { connectedWallet, disconnectedWallet, renderWithWallet } from "./support";

const OTHER = "0x52908400098527886E0F7030069857D2E4169EE7";

beforeEach(() => {
  window.history.replaceState(null, "", "#");
  window.localStorage.clear();
});

describe("the landing", () => {
  it("opens the bridge on the default pair for an empty hash, in place, with no chooser", async () => {
    window.history.replaceState(null, "", window.location.pathname);
    const before = window.history.length;
    renderWithWallet(<Shell />, { wallet: disconnectedWallet() });
    expect(await screen.findByTestId("page-name")).toHaveTextContent("Bridge");
    expect(screen.queryByRole("heading", { name: "Global view" })).toBeNull();
    expect(window.location.hash).toBe(`#/bridge/${FIXTURE_PAIR.id}`);
    expect(window.history.length).toBe(before);
  });

  it("sends the mark to the bridge on the default pair", async () => {
    window.history.replaceState(null, "", "#/audit");
    renderWithWallet(<Shell />, { wallet: disconnectedWallet() });
    expect(screen.getByRole("link", { name: "zkb.fi, the bridge" })).toHaveAttribute("href", `#/bridge/${FIXTURE_PAIR.id}`);
  });
});

describe("the pair view in the address", () => {
  it("opens with the filters of the link and writes a filter change back in place", async () => {
    window.history.replaceState(null, "", `#/pair/${FIXTURE_PAIR.id}?direction=first-to-second&range=24h`);
    renderWithWallet(<Shell />, { wallet: disconnectedWallet() });
    expect(await screen.findByLabelText("Direction")).toHaveValue("first-to-second");
    expect(screen.getByLabelText("Time range")).toHaveValue("24h");
    const before = window.history.length;
    await userEvent.selectOptions(screen.getByLabelText("Direction"), "all");
    await waitFor(() => expect(window.location.hash).toBe(`#/pair/${FIXTURE_PAIR.id}?range=24h`));
    expect(window.history.length).toBe(before);
  });
});

describe("a dialog in the address", () => {
  it("opens from the link, holds its fields in the address as the user types, and Back closes it", async () => {
    window.history.replaceState(null, "", `#/pair/${FIXTURE_PAIR.id}`);
    renderWithWallet(<Shell />, { wallet: connectedWallet() });
    await screen.findByRole("table", { name: "Transfers and messages" });
    act(() => {
      window.history.pushState(null, "", `#/pair/${FIXTURE_PAIR.id}?dialog=message&msg.gas=250000`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    const dialog = await screen.findByRole("dialog", { name: "Send a message" });
    expect(await within(dialog).findByLabelText(/^Gas for the call/)).toHaveValue("250000");
    const before = window.history.length;
    await userEvent.type(within(dialog).getByLabelText(/Target contract/), "0x12");
    await waitFor(() => expect(window.location.hash).toBe(`#/pair/${FIXTURE_PAIR.id}?dialog=message&msg.target=0x12&msg.gas=250000`));
    expect(window.history.length).toBe(before);
    act(() => {
      window.history.replaceState(null, "", `#/pair/${FIXTURE_PAIR.id}`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Send a message" })).toBeNull());
  });

  it("names the fields a link filled in that could send funds elsewhere", async () => {
    window.history.replaceState(null, "", `#/pair/${FIXTURE_PAIR.id}?dialog=message&msg.target=${OTHER}`);
    renderWithWallet(<Shell />, { wallet: connectedWallet() });
    const dialog = await screen.findByRole("dialog", { name: "Send a message" });
    expect(await within(dialog).findByText(/The link you opened filled in: target contract/)).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/Target contract/)).toHaveValue(OTHER);
  });

  it("names the linked fields of a dialog that a link opens after the page has loaded", async () => {
    window.history.replaceState(null, "", `#/pair/${FIXTURE_PAIR.id}`);
    renderWithWallet(<Shell />, { wallet: connectedWallet() });
    await screen.findByRole("table", { name: "Transfers and messages" });
    act(() => {
      window.history.pushState(null, "", `#/pair/${FIXTURE_PAIR.id}?dialog=message&msg.target=${OTHER}`);
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    const dialog = await screen.findByRole("dialog", { name: "Send a message" });
    expect(await within(dialog).findByText(/The link you opened filled in: target contract/)).toBeInTheDocument();
  });

  it("opens the settings dialog from the address", async () => {
    window.history.replaceState(null, "", "#/audit?dialog=settings");
    renderWithWallet(<Shell />, { wallet: disconnectedWallet() });
    expect(await screen.findByRole("dialog", { name: /Settings/ })).toBeInTheDocument();
  });
});

describe("the bridge dialog in the address", () => {
  it("writes the amount as the user types it, in place", async () => {
    window.history.replaceState(null, "", `#/pair/${FIXTURE_PAIR.id}?dialog=bridge`);
    renderWithWallet(<Shell />, { wallet: connectedWallet() });
    const dialog = await screen.findByRole("dialog", { name: "Bridge tokens" });
    const amount = await within(dialog).findByLabelText(/^Amount to send/);
    const before = window.history.length;
    await userEvent.type(amount, "2.5");
    await waitFor(() => expect(window.location.hash).toBe(`#/pair/${FIXTURE_PAIR.id}?dialog=bridge&bridge.amount=2.5`));
    expect(window.history.length).toBe(before);
  });
});

describe("edge cases of the address", () => {
  it("adds no history entry when a jump lands where the page already is", async () => {
    window.history.replaceState(null, "", `#/pair/${FIXTURE_PAIR.id}`);
    renderWithWallet(<Shell />, { wallet: disconnectedWallet() });
    await screen.findByRole("table", { name: "Transfers and messages" });
    const before = window.history.length;
    await userEvent.keyboard("{Control>}k{/Control}");
    const input = await screen.findByRole("combobox", { name: /Search/ });
    await userEvent.click(input);
    await userEvent.paste("Pair view");
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Search and jump" })).toBeNull());
    expect(window.location.hash).toBe(`#/pair/${FIXTURE_PAIR.id}`);
    expect(window.history.length).toBe(before);
  });

  it("asks for a wallet first when a link opens a filled form with no wallet connected", async () => {
    window.history.replaceState(null, "", `#/pair/${FIXTURE_PAIR.id}?dialog=bridge&bridge.receiver=${OTHER}`);
    renderWithWallet(<Shell />, { wallet: disconnectedWallet() });
    const dialog = await screen.findByRole("dialog", { name: "Bridge tokens" });
    expect(within(dialog).getByText(/Connect a wallet first/)).toBeInTheDocument();
  });
});
