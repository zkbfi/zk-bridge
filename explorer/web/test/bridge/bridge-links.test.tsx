import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { FIXTURE_PAIR } from "@terminal/data/fixtures";
import { Shell } from "../../src/app/Shell";
import { bridgeLinkedFields } from "../../src/app/route";
import { connectedWallet, renderWithWallet } from "../app/support";

const OTHER = "0x52908400098527886E0F7030069857D2E4169EE7";
const ROUTER = "0x1111111111111111111111111111111111111111";

beforeEach(() => {
  window.localStorage.clear();
});

describe("which link fields need the user's attention", () => {
  it("lets only the route, the token and the amount prefill silently", () => {
    expect(bridgeLinkedFields({ token: `first:${OTHER}`, amount: "1" }, null)).toEqual([]);
    expect(bridgeLinkedFields({ amount: "1", receiver: OTHER, callGas: "900000", tip: { routerText: ROUTER, fixedText: "5", mode: "fixed" } }, null)).toEqual(
      expect.arrayContaining(["receiver", "gas for the call", "relay router", "fixed tip", "tip kind"]),
    );
  });
});

describe("a crafted bridge link", () => {
  const crafted = `#/bridge/${FIXTURE_PAIR.id}?bridge.amount=0.01&bridge.receiver=${OTHER}&tip.mode=fixed&tip.fixed=5&tip.router=${ROUTER}`;

  it("names the receiver, the tip and the router on the screen", async () => {
    window.history.replaceState(null, "", crafted);
    renderWithWallet(<Shell />, { wallet: connectedWallet() });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/The link you opened filled in:/);
    expect(alert).toHaveTextContent(/receiver/);
    expect(alert).toHaveTextContent(/fixed tip/);
    expect(alert).toHaveTextContent(/relay router/);
  });

  it("does the same for a link opened after the page loaded", async () => {
    window.history.replaceState(null, "", `#/bridge/${FIXTURE_PAIR.id}`);
    renderWithWallet(<Shell />, { wallet: connectedWallet() });
    await screen.findByRole("region", { name: /You send from/ });
    expect(screen.queryByRole("alert")).toBeNull();
    act(() => {
      window.history.pushState(null, "", crafted);
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(/relay router/);
  });

  it("shows no warning for a link that sets only the route, the token and the amount", async () => {
    window.history.replaceState(null, "", `#/bridge/${FIXTURE_PAIR.id}?dir=second-to-first&bridge.amount=1`);
    renderWithWallet(<Shell />, { wallet: connectedWallet() });
    await screen.findByRole("region", { name: /You send from/ });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("repeats the warning in the review, with the full receiver address", async () => {
    window.history.replaceState(null, "", `#/bridge/${FIXTURE_PAIR.id}?bridge.amount=0.01&bridge.receiver=${OTHER}`);
    renderWithWallet(<Shell />, { wallet: connectedWallet() });
    const pill = await waitFor(() => {
      const found = screen.getAllByRole("button").find((button) => button.classList.contains("zb-go"));
      expect(found).toBeDefined();
      expect(found).not.toBeDisabled();
      return found!;
    });
    await userEvent.click(pill);
    const sheet = await screen.findByRole("dialog", { name: "Review" });
    expect(within(sheet).getByText(new RegExp(OTHER))).toBeInTheDocument();
    expect(within(sheet).getByRole("alert")).toHaveTextContent(/receiver/);
  });

  it("shows the full relay router in the review, with the warning for a router that is not the delivery router", async () => {
    window.history.replaceState(null, "", `#/bridge/${FIXTURE_PAIR.id}?bridge.amount=0.01&tip.router=${ROUTER}`);
    renderWithWallet(<Shell />, { wallet: connectedWallet() });
    const pill = await waitFor(() => {
      const found = screen.getAllByRole("button").find((button) => button.classList.contains("zb-go"));
      expect(found).not.toBeDisabled();
      return found!;
    });
    await userEvent.click(pill);
    const sheet = await screen.findByRole("dialog", { name: "Review" });
    expect(within(sheet).getByText(ROUTER)).toBeInTheDocument();
    expect(within(sheet).getAllByRole("alert").map((alert) => alert.textContent).join(" ")).toMatch(/not .*delivery router|relay router/i);
  });
});
