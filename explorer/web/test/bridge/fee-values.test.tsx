import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { routerCallbackGas , MAX_CALL_GAS } from "@zk-bridge/shared";
import { FIXTURE_PAIR } from "@terminal/data/fixtures";
import { Shell } from "../../src/app/Shell";
import { connectedWallet, renderWithWallet } from "../app/support";

// The owner (quote 90): every fee value is a slider with a recommended tick, an exact input and a reset; the delivery
// menu and the tip drawer edit the same value.

beforeEach(() => {
  window.localStorage.clear();
});

const at = async (query: string) => {
  window.history.replaceState(null, "", `#/bridge/${FIXTURE_PAIR.id}?${query}`);
  renderWithWallet(<Shell />, { wallet: connectedWallet() });
  await waitFor(() => expect(document.querySelector('[data-fee="tip"]')?.getAttribute("aria-label")).toMatch(/Fee \d/), { timeout: 3000 });
};
const menu = async () => {
  await userEvent.click(screen.getByRole("button", { name: /^Delivery settings/ }));
  return screen.getByRole("group", { name: "Delivery settings" });
};
const advanced = async (scope: HTMLElement) => userEvent.click(within(scope).getByRole("button", { name: "Advanced" }));
const drawer = async () => {
  await userEvent.click(screen.getAllByRole("button").find((button) => button.getAttribute("data-fee") === "tip")!);
  return document.querySelector<HTMLElement>(".zb-drawer")!;
};
const exact = (scope: HTMLElement, label: string) => within(scope).getByRole("textbox", { name: `${label}, exact` });
const retype = async (field: HTMLElement, text: string) => {
  await userEvent.clear(field);
  await userEvent.type(field, text);
};

describe("the fee values", () => {
  it("moves a fixed fee with its slider and resets it to the automatic fee's amount", async () => {
    await at("bridge.amount=500&tip.mode=fixed&tip.fixed=3");
    const scope = await menu();
    fireEvent.change(within(scope).getByRole("slider", { name: "Fixed fee" }), { target: { value: "4" } });
    await waitFor(() => expect(window.location.hash).toMatch(/tip\.fixed=4(&|$)/));
    await userEvent.click(within(scope).getAllByRole("button", { name: "Reset to recommended" })[0]!);
    await waitFor(() => expect(window.location.hash).not.toMatch(/tip\.fixed=4(&|$)/));
    expect(window.location.hash).toMatch(/tip\.fixed=/);
  });

  it("refuses a fixed fee above the amount", async () => {
    await at("bridge.amount=5&tip.mode=fixed&tip.fixed=0.1");
    const scope = await menu();
    await retype(exact(scope, "Fixed fee"), "6");
    expect(within(scope).getByRole("alert")).toHaveTextContent("The fee can't be more than the amount.");
  });

  it("moves a gas-based factor with its slider, refuses a bad one, and resets it", async () => {
    await at("dir=second-to-first&bridge.amount=1000&tip.mode=gas-multiplier&tip.price=3000");
    const scope = await menu();
    fireEvent.change(within(scope).getByRole("slider", { name: "Fee on gas" }), { target: { value: "3" } });
    await waitFor(() => expect(window.location.hash).toMatch(/tip\.gas=3(&|$)/));
    await retype(exact(scope, "Fee on gas"), "0");
    expect(within(scope).getByRole("alert")).toHaveTextContent("Use a number above 0 and at most 1000.");
    await retype(exact(scope, "Fee on gas"), "x");
    expect(within(scope).getByRole("alert")).toHaveTextContent("Enter a number, such as 2.");
    await userEvent.click(within(scope).getAllByRole("button", { name: "Reset to recommended" })[0]!);
    await waitFor(() => expect(window.location.hash).not.toMatch(/tip\.gas=3(&|$)/));
  });

  it("sets the gas price ceiling from its slider or its exact gwei, which moves the level", async () => {
    await at("bridge.amount=500&tip.mode=percentage&tip.percent=0.5");
    const scope = await menu();
    const slider = within(scope).getByRole("slider", { name: "Gas level" });
    fireEvent.change(slider, { target: { value: slider.getAttribute("max")! } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Gas level: High. Change" })).toBeInTheDocument());
    // A share the user set is rebased on the new cost, as the bars do.
    expect(window.location.hash).not.toMatch(/tip\.percent=0\.5(&|$)/);
    await retype(exact(scope, "Gas level"), "0");
    expect(within(scope).getByRole("alert")).toHaveTextContent(/above 0 in gwei/);
    const normal = within(scope).getAllByRole("button", { name: "Reset to recommended" });
    await userEvent.click(normal[normal.length - 1]!);
    await waitFor(() => expect(screen.getByRole("button", { name: "Gas level: Normal. Change" })).toBeInTheDocument());
    const wei = exact(within(scope).getByRole("slider", { name: "Gas level" }).closest(".zb-slider") as HTMLElement, "Gas level");
    await retype(wei, "100");
    await waitFor(() => expect(window.location.hash).toMatch(/tip\.ceiling=100(&|$)/));
  });

  it("names the call gas next to the call, shows the callback gas read only (none above the cap), and drops both with the call", async () => {
    await at("bridge.amount=500");
    const scope = await menu();
    await advanced(scope);
    expect(within(scope).queryByRole("textbox", { name: "Call gas" })).toBeNull();
    expect(within(scope).queryByTestId("callback-gas")).toBeNull();
    await userEvent.type(within(scope).getByRole("textbox", { name: /Call after delivery/ }), `0x${"77".repeat(20)}`);
    const callGas = within(scope).getByRole("textbox", { name: "Call gas" });
    await userEvent.type(callGas, "200000");
    await waitFor(() => expect(window.location.hash).toMatch(/bridge\.callGas=200000/));
    expect(within(scope).getByTestId("callback-gas")).toHaveTextContent(routerCallbackGas({ callGas: 200_000n }).toLocaleString("en-US"));
    await userEvent.clear(callGas);
    await userEvent.type(callGas, String(MAX_CALL_GAS + 1n));
    expect(within(scope).queryByTestId("callback-gas")).toBeNull();
    await userEvent.clear(callGas);
    await waitFor(() => expect(window.location.hash).not.toMatch(/bridge\.callGas/));
    expect(within(scope).queryByTestId("callback-gas")).toBeNull();
    await userEvent.type(callGas, "5");
    await userEvent.clear(within(scope).getByRole("textbox", { name: /Call after delivery/ }));
    await waitFor(() => expect(window.location.hash).not.toMatch(/bridge\.call/));
    expect(within(scope).queryByRole("textbox", { name: "Call gas" })).toBeNull();
  });

  it("types the router in the menu", async () => {
    await at("bridge.amount=500");
    const scope = await menu();
    await advanced(scope);
    await userEvent.type(within(scope).getByRole("textbox", { name: /Relay router/ }), "0xab");
    await waitFor(() => expect(window.location.hash).toMatch(/tip\.router=0xab/));
    await userEvent.clear(within(scope).getByRole("textbox", { name: /Relay router/ }));
    await waitFor(() => expect(window.location.hash).not.toMatch(/tip\.router/));
  });

  it("types both caps exactly and resets them; a link's automatic cap above the hard cap is held under it", async () => {
    await at("bridge.amount=500&tip.cap=3");
    const scope = await drawer();
    expect(within(scope).getByRole("slider", { name: "Automatic fee cap" })).toHaveValue("2");
    await retype(exact(scope, "Hard fee cap"), "4");
    await waitFor(() => expect(within(scope).getByRole("slider", { name: "Hard fee cap" })).toHaveValue("4"));
    await retype(exact(scope, "Automatic fee cap"), "3");
    await waitFor(() => expect(within(scope).getByRole("slider", { name: "Automatic fee cap" })).toHaveValue("3"));
    const resets = () => within(scope).getAllByRole("button", { name: "Reset to recommended" });
    await userEvent.click(resets()[resets().length - 1]!);
    await waitFor(() => expect(within(scope).getByRole("slider", { name: "Hard fee cap" })).toHaveValue("2"));
    expect(within(scope).getByRole("slider", { name: "Automatic fee cap" })).toHaveValue("2");
    await userEvent.click(resets()[resets().length - 1]!);
    await waitFor(() => expect(within(scope).getByRole("slider", { name: "Automatic fee cap" })).toHaveValue("1"));
  });
});
