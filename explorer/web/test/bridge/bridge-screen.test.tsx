import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { FIXTURE_PAIR } from "@terminal/data/fixtures";
import { Shell } from "../../src/app/Shell";
import { connectedWallet, disconnectedWallet, renderWithWallet } from "../app/support";

beforeEach(() => {
  window.history.replaceState(null, "", `#/bridge/${FIXTURE_PAIR.id}`);
  window.localStorage.clear();
});

const renderBridge = (connected = true) => renderWithWallet(<Shell />, { wallet: connected ? connectedWallet() : disconnectedWallet() });

const fromBand = () => screen.getByRole("region", { name: `You send from ${FIXTURE_PAIR.first.name}` });
const toBand = () => screen.getByRole("region", { name: `You receive on ${FIXTURE_PAIR.second.name}` });

describe("the bridge screen", () => {
  it("opens on the From row: From, the source chain's icon and your account", async () => {
    renderBridge();
    const from = await screen.findByRole("button", { name: `From ${FIXTURE_PAIR.first.name}. Change the route` });
    expect(within(from).getByRole("img", { name: FIXTURE_PAIR.first.name })).toBeInTheDocument();
    expect(screen.getAllByText(/0x[0-9a-fA-F]{4}…[0-9a-fA-F]{4}/).length).toBeGreaterThan(0);
  });

  it("puts the balance and MAX on the right, and MAX fills the amount and writes the address", async () => {
    renderBridge();
    const max = await within(fromBand()).findByRole("button", { name: "MAX" });
    await userEvent.click(max);
    const input = within(fromBand()).getByRole("textbox", { name: `Amount to send from ${FIXTURE_PAIR.first.name}` });
    expect((input as HTMLInputElement).value).not.toBe("");
    await waitFor(() => expect(window.location.hash).toMatch(/bridge\.amount=/));
  });

  it("shows the output with the input token's icon and the destination badge, and says what it arrives as", async () => {
    renderBridge();
    await userEvent.type(await within(fromBand()).findByRole("textbox", { name: /Amount to send/ }), "1");
    const out = toBand();
    await waitFor(() => expect(out.querySelector("[data-badge]")).not.toBeNull());
    expect(out.querySelector("[data-badge]")?.getAttribute("data-badge")).toBe(String(FIXTURE_PAIR.second.chainId));
    expect(within(out).getByText(/arrives as/)).toHaveTextContent("arrives as zUSDC");
  });

  it("flips the direction and keeps the amount", async () => {
    renderBridge();
    await userEvent.type(await within(fromBand()).findByRole("textbox", { name: /Amount to send/ }), "2");
    await userEvent.click(screen.getByRole("button", { name: /^Flip/ }));
    await waitFor(() => expect(window.location.hash).toMatch(/dir=second-to-first/));
    expect(window.location.hash).toMatch(/bridge\.amount=2/);
    expect(await screen.findByRole("region", { name: `You send from ${FIXTURE_PAIR.second.name}` })).toBeInTheDocument();
  });

  it("asks for a wallet in the Bridge pill when none is connected", async () => {
    renderBridge(false);
    await screen.findAllByRole("button", { name: "Connect wallet" });
    const pill = screen.getAllByRole("button").find((button) => button.classList.contains("zb-go"))!;
    expect(pill).toHaveTextContent("Connect wallet");
    expect(pill).not.toBeDisabled();
  });

  it("never uses a native select, and every chain and token shows as an image", async () => {
    const { container } = renderBridge();
    await within(fromBand()).findByRole("button", { name: /^Token:/ });
    expect(container.querySelector("select")).toBeNull();
    expect(container.querySelectorAll(".zb-tok-icon img").length).toBeGreaterThan(2);
  });

  it("opens the review sheet from the Bridge pill, never the wallet directly", async () => {
    renderBridge();
    await userEvent.type(await within(fromBand()).findByRole("textbox", { name: /Amount to send/ }), "0.01");
    const pill = screen.getAllByRole("button").find((button) => button.classList.contains("zb-go"))!;
    await waitFor(() => expect(pill).not.toBeDisabled(), { timeout: 3000 }).catch(() => {
      throw new Error(`the pill says "${pill.textContent}" and "${document.querySelector(".zb-verdict")?.textContent ?? ""}"`);
    });
    await userEvent.click(pill);
    const sheet = await screen.findByRole("dialog", { name: "Review" });
    expect(within(sheet).getByRole("button", { name: "Confirm in wallet" })).toBeInTheDocument();
  });
});

describe("the token picker", () => {
  it("opens on an orange search band with a square close, icon-only tabs, no title and no check mark (owner, rounds 3 to 7)", async () => {
    renderBridge();
    await userEvent.click(await within(fromBand()).findByRole("button", { name: /^Token:/ }));
    const picker = await screen.findByRole("dialog", { name: "Choose a token" });
    expect(within(picker).queryByRole("heading")).toBeNull();
    const search = within(picker).getByRole("combobox", { name: "Search tokens" });
    const band = search.parentElement!;
    expect(band.className).toBe("zb-picker-search");
    expect(band.lastElementChild).toHaveAccessibleName("Close");
    expect(band.lastElementChild?.textContent).toBe("");
    const tabs = within(picker).getAllByRole("tab");
    expect(tabs.map((tab) => tab.getAttribute("aria-label"))).toEqual(["All chains", FIXTURE_PAIR.first.name, FIXTURE_PAIR.second.name]);
    expect(tabs.map((tab) => tab.textContent)).toEqual(["", "", ""]);
    expect(picker.textContent).not.toMatch(/✓|✔/);
  });

  it("names no chain in the rows; each icon's badge is the token's origin chain", async () => {
    renderBridge();
    await userEvent.click(await within(fromBand()).findByRole("button", { name: /^Token:/ }));
    const picker = await screen.findByRole("dialog", { name: "Choose a token" });
    await userEvent.type(within(picker).getByRole("combobox", { name: "Search tokens" }), "0x");
    const rows = within(picker).getAllByRole("option");
    for (const row of rows) {
      expect(row.textContent).not.toContain(FIXTURE_PAIR.first.name);
      expect(row.textContent).not.toContain(FIXTURE_PAIR.second.name);
      expect(row.querySelector("[data-badge]")).not.toBeNull();
    }
  });

  it("searches every token, and picking one on the other chain flips the direction", async () => {
    renderBridge();
    await userEvent.click(await within(fromBand()).findByRole("button", { name: /^Token:/ }));
    const picker = await screen.findByRole("dialog", { name: "Choose a token" });
    await userEvent.click(within(picker).getByRole("tab", { name: FIXTURE_PAIR.second.name }));
    await userEvent.type(within(picker).getByRole("combobox", { name: "Search tokens" }), "0x");
    const options = within(picker).getAllByRole("option");
    expect(options.length).toBeGreaterThan(0);
    await userEvent.click(options[0]!);
    await waitFor(() => expect(window.location.hash).toMatch(/dir=second-to-first/));
  });
});

describe("the route menu", () => {
  it("drops from the From pill, marks the current route without a check, and closes with Escape", async () => {
    renderBridge();
    await userEvent.click(await screen.findByRole("button", { name: /^From .*Change the route/ }));
    const menu = screen.getByRole("menu", { name: "Route" });
    const current = within(menu).getAllByRole("menuitemradio").find((item) => item.getAttribute("aria-checked") === "true");
    expect(current).toBeDefined();
    expect(menu.textContent).not.toMatch(/✓|✔/);
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
