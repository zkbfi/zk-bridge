import { screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FIXTURE_PAIR } from "@terminal/data/fixtures";
import { Shell } from "../../src/app/Shell";
import { connectedWallet, renderWithWallet } from "../app/support";

// Recorded chain reads: the verifier of the light client on Sepolia and block 25,767,883 of PulseChain testnet v4.
vi.mock("../../src/explore/chain-reader", async (original) => {
  const actual = await original<typeof import("../../src/explore/chain-reader")>();
  const reader = {
    transaction: async () => {
      throw new Error("not recorded");
    },
    block: async (number: bigint) => ({ number, hash: "0x9ddeae6daafa2e91d57c8efa240583ff83c1f95a2e20cce68a6564e56303ac43", timestamp: 1793300049n, gasUsed: 0n, baseFeePerGas: 7n, transactions: [] }),
    verifier: async () => "0xF711000000000000000000000000000000007f67",
    account: async () => ({ balance: 0n, nonce: 1, isContract: true }),
  };
  return { ...actual, useChainReader: () => () => reader };
});

const open = (hash: string) => {
  window.history.replaceState(null, "", hash);
  return renderWithWallet(<Shell />, { wallet: connectedWallet() });
};

beforeEach(() => window.localStorage.clear());

describe("Explore's other pages", () => {
  it("a proof: slot and block linking on, the committee period, the posting transaction, the verifier, gas and cost; signers and proving time as —", async () => {
    open("#/explore/proof/11155111/1");
    expect(await screen.findByText("Proof #1", { selector: ".zb-xband-big" })).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: "11,194,368" })).toHaveAttribute("href", "#/explore/slot/11194368");
    expect(screen.getByText(/period 1,366/)).toBeInTheDocument();
    expect(screen.getByText("Posted in").nextElementSibling).toHaveAttribute("href", "#/explore/tx/11155111/0x4663c8c20fc80a37f8e93102602d2fb969e93d1973c49011edff6915ab4828db");
    await waitFor(() => expect(screen.getByText("Verifier").nextElementSibling).toHaveAttribute("href", expect.stringMatching(/^#\/explore\/contract\/11155111\//)));
    expect(screen.getByText(/604,091 gas/)).toBeInTheDocument();
    expect(screen.getByText("Proving time").nextElementSibling).toHaveTextContent("—");
  });

  it("a slot lists the proof that stored it", async () => {
    open("#/explore/slot/11194368");
    expect(await screen.findByRole("link", { name: /Proof #1/ })).toHaveAttribute("href", "#/explore/proof/11155111/1");
  });

  it("a block reads the chain and names the proof that proves it final", async () => {
    open(`#/explore/block/${FIXTURE_PAIR.second.chainId}/25767883`);
    expect(await screen.findByText("Block 25,767,883")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/0x9ddeae6d…ac43/)).toBeInTheDocument());
  });

  it("a gate shows its state from the indexer", async () => {
    open("#/explore/gate/11155111");
    expect(await screen.findByText("Gate · closed")).toBeInTheDocument();
    expect(screen.getByText("Enforcing").nextElementSibling).toHaveTextContent("yes");
  });

  it("the costs page shows the light-client updates and the proof", async () => {
    open("#/explore/costs");
    expect(await screen.findByText("1 updates")).toBeInTheDocument();
    expect(screen.getByText("$0.025 (assumed)")).toBeInTheDocument();
  });

  it("a token page for a native coin names it and its transfers", async () => {
    open("#/explore/token/first/0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE");
    expect(await screen.findByText(FIXTURE_PAIR.first.nativeSymbol, { selector: ".zb-xband-big" })).toBeInTheDocument();
    expect(screen.getByText("native coin")).toBeInTheDocument();
  });
});
