import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { formatTransaction, formatTransactionReceipt } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FIXTURE_PAIR } from "@terminal/data/fixtures";
import { Shell } from "../../src/app/Shell";
import { connectedWallet, renderWithWallet } from "../app/support";
import { RECORDED_RECEIPT, RECORDED_TX } from "./recorded-tx";

// The chains are replaced by the recorded transaction and a recorded account (the deployer: 1.213127 ETH, nonce 8).
vi.mock("../../src/explore/chain-reader", async (original) => {
  const actual = await original<typeof import("../../src/explore/chain-reader")>();
  const reader = {
    transaction: async () => ({ tx: formatTransaction(RECORDED_TX as never), receipt: formatTransactionReceipt(RECORDED_RECEIPT as never) }),
    block: async (number: bigint) => ({ number, timestamp: 1793300049n }),
    account: async () => ({ balance: 1_213_127_000_000_000_000n, nonce: 8, isContract: false }),
  };
  return { ...actual, useChainReader: () => () => reader };
});

const TX = "0x4663c8c20fc80a37f8e93102602d2fb969e93d1973c49011edff6915ab4828db";
const css = readFileSync(`${process.cwd()}/src/explore/explore.css`, "utf8");

beforeEach(() => {
  window.localStorage.clear();
});

describe("the transaction page", () => {
  it("shows the kind, the decoded details, where it sits with short labels, the events and the raw input collapsed; no prose", async () => {
    // The light client of the recorded update is the fixture pair's own on the first chain.
    window.history.replaceState(null, "", `#/explore/tx/${FIXTURE_PAIR.first.chainId}/${TX}`);
    const { container } = renderWithWallet(<Shell />, { wallet: connectedWallet() });
    expect(await screen.findByText(/^update\(bytes/)).toBeInTheDocument();
    expect(screen.getByText("604,091", { exact: false })).toBeInTheDocument();
    expect(screen.getByText(/7 · index 59/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Where it sits/ })).toBeInTheDocument();
    expect(screen.getByText("HeadUpdated")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Input data \(.* bytes\)/ })).toHaveAttribute("aria-expanded", "false");
    expect(container.textContent).not.toMatch(/now trusts|can be proven/);
  });
});

describe("the step drawers on a joined step list", () => {
  it("open inside the step, so the step's line runs through the drawer", async () => {
    const { StepTrail } = await import("../../src/explore/StepTrail");
    const { render } = await import("@testing-library/react");
    render(
      <StepTrail
        steps={[
          { label: "Transfer sent · 80 USDC", done: true, when: "22:09", drawer: <span>sent details</span> },
          { label: "Block final on PulseChain", done: true, when: "22:14", drawer: <span>Block 25,767,883</span> },
          { label: "Delivered on Sepolia", done: false, when: "waiting" },
        ]}
      />,
    );
    const step = screen.getByRole("button", { name: /Block final on PulseChain/ });
    await userEvent.click(step);
    expect(step).toHaveAttribute("aria-expanded", "true");
    const item = step.closest("li")!;
    const drawer = document.getElementById(step.getAttribute("aria-controls")!)!;
    expect(item.contains(drawer)).toBe(true);
    expect(drawer).toHaveClass("zb-open");
    expect(within(drawer).getByText("Block 25,767,883")).toBeInTheDocument();
    expect(item).toHaveAttribute("data-state", "done");
    // The line is the item's own ::before from the dot to the item's bottom (drawer included), lit for a done step.
    expect(css).toMatch(/\.zb-trail-step \{ display: block;/);
    expect(css).toMatch(/\.zb-trail-step::before \{ bottom: -2px; \}/);
  });
});

describe("the address page", () => {
  it("shows the identity band with roles, balance and activity per chain, totals through zkb.fi, and its proofs", async () => {
    window.history.replaceState(null, "", "#/explore/address/0xF71cBAA5a165fad2FfFf6B0D68E84D67b1f75eAc");
    renderWithWallet(<Shell />, { wallet: connectedWallet() });
    expect(await screen.findByText("0xF71cBAA5a165fad2FfFf6B0D68E84D67b1f75eAc")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("proof poster")).toBeInTheDocument());
    expect(screen.getByText("account")).toBeInTheDocument();
    expect(screen.getAllByText(/8 transactions sent/)).toHaveLength(2);
    await userEvent.click(screen.getByRole("tab", { name: /Proofs/ }));
    expect(screen.getByRole("link", { name: /Proof #1/ })).toHaveAttribute("href", "#/explore/proof/11155111/1");
    expect(screen.getByRole("link", { name: /Bridge to this address/ }).getAttribute("href")).toMatch(/bridge\.receiver=0xF71cBAA5a165fad2FfFf6B0D68E84D67b1f75eAc/);
  });
});
