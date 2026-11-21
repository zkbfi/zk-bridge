import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChainSnapshotResult } from "@terminal/chain/live-reads";
import type { TokenInfo } from "@terminal/model/types";
import { FIXTURE_PAIR } from "@terminal/data/fixtures";
import { Shell } from "../../src/app/Shell";
import { choiceOf } from "../../src/bridge/bridge-model";
import { FAUCET_TOKEN_ADDRESS, faucetTokensOf } from "../../src/faucet/faucet-model";
import { buildTestServices } from "../render";
import { connectedWallet, disconnectedWallet, renderWithWallet } from "../app/support";
import { TESTNET } from "./testnet-pair";

// The confirm dialog is tested with the sequence; here it is a stand-in that shows the step the screen hands it.
vi.mock("../../src/actions/TransactionDialog", () => ({
  TransactionDialog: ({ steps, onClose }: { steps: readonly { plan: { title: string } }[]; onClose: () => void }) => (
    <div role="dialog" aria-label="Signing">
      {steps.map((step) => step.plan.title).join(", ")}
      <button type="button" onClick={onClose}>
        close
      </button>
    </div>
  ),
}));

const FAUCET = faucetTokensOf(TESTNET)[0]!;
const TFAU_QUERY = `bridge.token=${encodeURIComponent(choiceOf(FAUCET))}`;

type Balances = { readonly coin: bigint; readonly tfau: bigint };

/** Services on the testnet pair whose wallet holds the given coin and tFAU on every chain. */
const testnetServices = (balances: Balances) => {
  const base = buildTestServices();
  return {
    pair: TESTNET,
    chainAccess: {
      ...base.chainAccess,
      readSnapshots: async ({ tokens }: { tokens: readonly TokenInfo[] }): Promise<ChainSnapshotResult[]> =>
        [TESTNET.first, TESTNET.second].map((chain) => ({
          status: "ok",
          snapshot: {
            chain,
            nativeBalance: balances.coin,
            positions: tokens.filter((token) => token.side === chain.side).map((token) => ({ token, balance: token.symbol === "tFAU" ? balances.tfau : 10n ** 18n, allowance: 0n })),
          },
        })),
    },
  };
};

const open = (query: string, balances: Balances, connected = true) => {
  window.history.replaceState(null, "", `#/bridge/${TESTNET.id}${query === "" ? "" : `?${query}`}`);
  return renderWithWallet(<Shell />, { wallet: connected ? connectedWallet() : disconnectedWallet(), services: testnetServices(balances) });
};

const GAS = 10n ** 18n;

beforeEach(() => {
  window.localStorage.clear();
});

describe("the token picker on the testnet pair", () => {
  it("lists tFAU with a small Mint 1,000 action even when the wallet holds none, and no other row has one", async () => {
    open("", { coin: GAS, tfau: 0n });
    await userEvent.click(await screen.findByRole("button", { name: /^Token: / }));
    const row = (await screen.findByText("tFAU")).closest("li")!;
    const mint = within(row).getByRole("button", { name: `Mint 1,000 tFAU on ${TESTNET.first.name}` });
    expect(screen.getAllByRole("button", { name: /^Mint 1,000/ })).toEqual([mint]);
    await userEvent.click(mint);
    expect(await screen.findByRole("dialog", { name: "Signing" })).toHaveTextContent(`Mint 1,000 tFAU on ${TESTNET.first.name}`);
    expect(screen.queryByRole("listbox", { name: "Tokens" })).toBeNull();
  });

  it("mints on the chain of a tFAU row of the other tab", async () => {
    open("", { coin: GAS, tfau: 0n });
    await userEvent.click(await screen.findByRole("button", { name: /^Token: / }));
    await userEvent.click(await screen.findByRole("tab", { name: TESTNET.second.name }));
    await userEvent.click(await screen.findByRole("button", { name: `Mint 1,000 tFAU on ${TESTNET.second.name}` }));
    expect(await screen.findByRole("dialog", { name: "Signing" })).toHaveTextContent(`Mint 1,000 tFAU on ${TESTNET.second.name}`);
  });

  it("picks tFAU by its row, not by its action", async () => {
    open("", { coin: GAS, tfau: 0n });
    await userEvent.click(await screen.findByRole("button", { name: /^Token: / }));
    await userEvent.click((await screen.findByText("tFAU")).closest("li")!);
    expect(await screen.findByRole("button", { name: "Token: tFAU. Choose another" })).toBeInTheDocument();
  });
});

describe("the help under the amount on the testnet pair", () => {
  it("says You have 0 tFAU with a Mint 1,000 action and a link to the docs page, when tFAU is selected and the balance is 0", async () => {
    open(TFAU_QUERY, { coin: GAS, tfau: 0n });
    const note = await screen.findByTestId("faucet-help");
    expect(note).toHaveTextContent("You have 0 tFAU · Mint 1,000 · How testnet tokens work");
    expect(within(note).getByRole("link", { name: "How testnet tokens work" })).toHaveAttribute("href", "#/docs/get-testnet-tokens");
    await userEvent.click(within(note).getByRole("button", { name: "Mint 1,000" }));
    expect(await screen.findByRole("dialog", { name: "Signing" })).toHaveTextContent(`Mint 1,000 tFAU on ${TESTNET.first.name}`);
  });

  it("shows nothing about tFAU once the wallet holds some", async () => {
    open(TFAU_QUERY, { coin: GAS, tfau: 5n * 10n ** 18n });
    await screen.findByRole("button", { name: "Token: tFAU. Choose another" });
    await waitFor(() => expect(screen.getByText(/^Balance/)).toBeInTheDocument());
    expect(screen.queryByTestId("faucet-help")).toBeNull();
  });

  it("says the wallet needs coin for gas, with the faucet of the source chain in a new tab, before it offers the mint", async () => {
    open(TFAU_QUERY, { coin: 0n, tfau: 0n });
    const note = await screen.findByTestId("faucet-help");
    expect(note).toHaveTextContent("You need Sepolia ETH to send · Get some · How testnet tokens work");
    expect(within(note).queryByRole("button", { name: "Mint 1,000" })).toBeNull();
    const link = within(note).getByRole("link", { name: "Get some" });
    expect(link).toHaveAttribute("href", "https://sepolia-faucet.pk910.de/");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(within(note).getByRole("link", { name: "How testnet tokens work" })).toHaveAttribute("href", "#/docs/get-testnet-tokens");
  });

  it("names the PulseChain testnet faucet when the transfer leaves from PulseChain testnet v4", async () => {
    open("dir=second-to-first", { coin: 0n, tfau: GAS });
    const note = await screen.findByTestId("faucet-help");
    expect(note).toHaveTextContent("You need testnet PLS to send · Get some");
    expect(within(note).getByRole("link", { name: "Get some" })).toHaveAttribute("href", "https://faucet.v4.testnet.pulsechain.com/");
  });

  it("shows no help without a connected wallet", async () => {
    open(TFAU_QUERY, { coin: 0n, tfau: 0n }, false);
    await screen.findByRole("button", { name: "Token: tFAU. Choose another" });
    expect(screen.queryByTestId("faucet-help")).toBeNull();
  });
});

describe("a build on any other pair", () => {
  const openOnMain = async () => {
    window.history.replaceState(null, "", `#/bridge/${FIXTURE_PAIR.id}`);
    renderWithWallet(<Shell />, { wallet: connectedWallet() });
    await userEvent.click(await screen.findByRole("button", { name: /^Token: / }));
    await screen.findByRole("listbox", { name: "Tokens" });
  };

  it("lists no tFAU, offers no mint and shows no help", async () => {
    await openOnMain();
    expect(screen.queryByText("tFAU")).toBeNull();
    expect(screen.queryByRole("button", { name: /Mint 1,000/ })).toBeNull();
    expect(screen.queryByTestId("faucet-help")).toBeNull();
    expect(FAUCET_TOKEN_ADDRESS[FIXTURE_PAIR.first.chainId]).toBeUndefined();
  });
});
