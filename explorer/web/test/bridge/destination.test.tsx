import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { FIXTURE_PAIR } from "@terminal/data/fixtures";
import { Shell } from "../../src/app/Shell";
import { destinationProblem, LOCK_TIPS } from "../../src/bridge/destination";
import { WalletContext } from "../../src/wallet/wallet-port";
import { connectedWallet, renderWithWallet, walletWrapper } from "../app/support";
import { USDC_QUERY } from "./token-link";

// The owner (quotes 96–97): the To row is locked to the connected wallet by default; unlocked, its right part is the
// address field in place, and the address floats free of the wallet.

const OTHER = "0x52908400098527886E0F7030069857D2E4169EE7";

beforeEach(() => {
  window.localStorage.clear();
});

const at = async (query: string) => {
  window.history.replaceState(null, "", `#/bridge/${FIXTURE_PAIR.id}?${USDC_QUERY}&${query}`);
  renderWithWallet(<Shell />, { wallet: connectedWallet() });
  await waitFor(() => expect(document.querySelector('[data-fee="tip"]')?.getAttribute("aria-label")).toMatch(/Fee \d/), { timeout: 3000 });
};
const lock = () => screen.getByRole("button", { name: /^Destination (locked|unlocked)/ });
const field = () => screen.queryByRole("textbox", { name: /^Destination address/ });

describe("destinationProblem", () => {
  it("takes a checksummed or lower-case address and names every other problem", () => {
    expect(destinationProblem(OTHER)).toBeNull();
    expect(destinationProblem(OTHER.toLowerCase())).toBeNull();
    expect(destinationProblem("")).toMatch(/Type the destination address/);
    expect(destinationProblem("0x1234")).toMatch(/40 hex characters/);
    expect(destinationProblem(`0x${"0".repeat(40)}`)).toMatch(/zero address/);
    expect(destinationProblem(OTHER.replace("E0F", "e0f"))).toMatch(/checksum/);
  });
});

describe("the destination row", () => {
  it("is locked by default: it shows the connected wallet, with no field and no menu", async () => {
    await at("bridge.amount=500");
    expect(lock()).toHaveAttribute("aria-pressed", "true");
    expect(field()).toBeNull();
    expect(screen.queryByText("your wallet")).toBeNull();
    await userEvent.hover(lock());
    expect(screen.getByRole("tooltip")).toHaveTextContent(LOCK_TIPS.locked);
  });

  it("unlocks into an address field in place, writes the address to the link, and checks it inline", async () => {
    await at("bridge.amount=500");
    await userEvent.click(lock());
    expect(lock()).toHaveAttribute("aria-pressed", "false");
    expect(field()).toHaveFocus();
    expect(screen.getByRole("button", { name: "Check the destination" })).toBeDisabled();
    await userEvent.type(field()!, `0x${"0".repeat(40)}`);
    expect(screen.getByRole("alert")).toHaveTextContent(/zero address/);
    await userEvent.clear(field()!);
    await userEvent.type(field()!, OTHER);
    await waitFor(() => expect(window.location.hash).toMatch(new RegExp(`bridge\\.receiver=${OTHER}`, "i")));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("Not your wallet. Check the address.")).toBeInTheDocument();
    await userEvent.hover(lock());
    expect(screen.getByRole("tooltip")).toHaveTextContent(LOCK_TIPS.unlocked);
  });

  it("locks again: the typed address leaves the link and the wallet takes over", async () => {
    await at(`bridge.amount=500&bridge.receiver=${OTHER}`);
    expect(field()).toHaveValue(OTHER);
    await userEvent.click(lock());
    expect(field()).toBeNull();
    await waitFor(() => expect(window.location.hash).not.toMatch(/bridge\.receiver/));
    expect(lock()).toHaveAttribute("aria-pressed", "true");
  });

  it("a locked row follows the connected wallet; an unlocked one keeps the typed address when the wallet changes", async () => {
    window.history.replaceState(null, "", `#/bridge/${FIXTURE_PAIR.id}?${USDC_QUERY}&bridge.amount=500`);
    const first = connectedWallet();
    const second = connectedWallet({ account: "0x1111111111111111111111111111111111111111" });
    const ui = (wallet: typeof first) => (
      <WalletContext.Provider value={wallet}>
        <Shell />
      </WalletContext.Provider>
    );
    const { rerender } = render(ui(first), { wrapper: walletWrapper({ wallet: first }) });
    await waitFor(() => expect(document.querySelector('[data-fee="tip"]')?.getAttribute("aria-label")).toMatch(/Fee \d/), { timeout: 3000 });
    expect(document.querySelector(".zb-dest-wallet")?.textContent).toBe(first.account);
    expect(document.querySelector(".zb-dest-wallet .zb-addr")).toHaveAttribute("title", first.account);
    expect(document.querySelector(".zb-joined:not(.zb-dest) .zb-addr")?.textContent).toBe(first.account);
    rerender(ui(second));
    await waitFor(() => expect(document.querySelector(".zb-dest-wallet")?.textContent).toMatch(/^0x1111/));
    await userEvent.click(lock());
    await userEvent.type(field()!, OTHER);
    rerender(ui(first));
    expect(field()).toHaveValue(OTHER);
    await waitFor(() => expect(window.location.hash).toMatch(new RegExp(`bridge\\.receiver=${OTHER}`, "i")));
  });
});
