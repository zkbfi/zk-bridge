import { screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FIXTURE_PAIR } from "@terminal/data/fixtures";
import type { PairConfig } from "@terminal/model/types";
import { shortAmountText } from "../../src/bridge/number";
import { Shell } from "../../src/app/Shell";
import { createFixtureExploreSource } from "../../src/explore/explore-fixture";
import type { ExploreSource } from "../../src/explore/explore-source";
import { stepCostText } from "../../src/explore/message-model";
import { connectedWallet, renderWithWallet } from "../app/support";

vi.mock("../../src/explore/chain-reader", async (original) => {
  const actual = await original<typeof import("../../src/explore/chain-reader")>();
  const reader = {
    transaction: async () => {
      throw new Error("not recorded");
    },
    block: async () => {
      throw new Error("not recorded");
    },
    verifier: async () => "0xF711000000000000000000000000000000007f67",
    account: async () => ({ balance: 0n, nonce: 1, isContract: true }),
  };
  return { ...actual, useChainReader: () => () => reader };
});

const SEPOLIA_PAIR: PairConfig = {
  ...FIXTURE_PAIR,
  id: "sepolia-pls943",
  first: { ...FIXTURE_PAIR.first, chainId: 11155111, name: "Sepolia", nativeSymbol: "SepETH" },
  second: { ...FIXTURE_PAIR.second, chainId: 943, name: "PulseChain testnet v4", nativeSymbol: "v4tPLS" },
};
const TX = "0x4663c8c20fc80a37f8e93102602d2fb969e93d1973c49011edff6915ab4828db";
const POSTER = "0xF71cBAA5a165fad2FfFf6B0D68E84D67b1f75eAc";

// The recorded source with a beacon clock (the beacon chain of PulseChain testnet v4, which the Sepolia light client follows: genesis 1655733600, 12 s slots), so the slot has a time.
const explore: ExploreSource = { ...createFixtureExploreSource(), beaconClocks: async () => [{ trackedChainId: 943, genesisTime: 1_655_733_600, secondsPerSlot: 12 }] };

const open = (hash: string) => {
  window.history.replaceState(null, "", hash);
  return renderWithWallet(<Shell />, { wallet: connectedWallet(), services: { pair: SEPOLIA_PAIR, explore } });
};
const row = (name: string) => screen.getByText(name, { selector: ".zb-k" }).parentElement as HTMLElement;
const hrefs = (element: HTMLElement) => within(element).queryAllByRole("link").map((link) => link.getAttribute("href"));

beforeEach(() => window.localStorage.clear());

describe("the proof page names what is authoritative", () => {
  it("shows the slots, the light client and the transaction that put the update on chain", async () => {
    open("#/explore/proof/11155111/1");
    await screen.findByText("Gas used", { selector: ".zb-k" });
    // From the first update (no earlier one is known) to slot 11,194,368, with the time of the beacon slot.
    expect(row("Slots")).toHaveTextContent("first update");
    expect(row("Slots")).toHaveTextContent("11,194,368");
    expect(hrefs(row("Slots"))).toContain("#/explore/slot/11194368");
    // 1,655,733,600 + 11,194,368 × 12 = 1,790,066,016 (2026-09-22T08:33:36Z)
    await waitFor(() => expect(row("Slot time")).toHaveTextContent("2026-09-22 08:33:36 UTC"));
    await waitFor(() => expect(hrefs(row("Light client"))).toContain("https://sepolia.etherscan.io/address/" + SEPOLIA_PAIR.first.contracts.lightClient));
    expect(hrefs(row("Light client"))[0]).toBe(`#/explore/contract/11155111/${SEPOLIA_PAIR.first.contracts.lightClient}`);
    expect(hrefs(row("Transaction"))).toEqual([`#/explore/tx/11155111/${TX}`, `https://sepolia.etherscan.io/tx/${TX}`, `https://eth-sepolia.blockscout.com/tx/${TX}`]);
    expect(row("Block")).toHaveTextContent("12,021,502");
    expect(hrefs(row("Block"))).toContain("https://sepolia.etherscan.io/block/12021502");
    expect(row("Time")).toHaveTextContent("2026-10-29");
    expect(hrefs(row("Sender"))).toEqual([`#/explore/address/${POSTER}`, `https://sepolia.etherscan.io/address/${POSTER}`, `https://eth-sepolia.blockscout.com/address/${POSTER}`]);
    expect(row("Gas used")).toHaveTextContent("604,091");
  });

  it("states the cost in SepETH, never ETH, and has no dollars where there is no price", async () => {
    open("#/explore/proof/11155111/1");
    await screen.findByText("Gas used", { selector: ".zb-k" });
    expect(row("Cost")).toHaveTextContent(/\d SepETH$/);
    expect(row("Cost")).not.toHaveTextContent(/(^|[^p])ETH/);
  });

  it("gives the second explorer of PulseChain testnet v4 beside the first", async () => {
    const source: ExploreSource = {
      ...explore,
      proofs: async () => (await explore.proofs()).map((proof) => ({ ...proof, chainId: 943 })),
    };
    window.history.replaceState(null, "", "#/explore/proof/943/1");
    renderWithWallet(<Shell />, { wallet: connectedWallet(), services: { pair: SEPOLIA_PAIR, explore: source } });
    await screen.findByText("Gas used", { selector: ".zb-k" });
    expect(hrefs(row("Transaction"))).toEqual([
      `#/explore/tx/943/${TX}`,
      `https://scan.v4.testnet.pulsechain.com/#/tx/${TX}`,
      `https://otter-testnet-pulsechain.g4mm4.io/tx/${TX}`,
    ]);
    expect(row("Cost")).toHaveTextContent("v4tPLS");
  });
});

describe("a cost in the native coin carries the ticker of the chain it was paid on", () => {
  const cost = (chainId: number) => ({ chainId, costWei: "60409100000000", costUsd: null }) as unknown as Parameters<typeof stepCostText>[0];
  it.each([
    [SEPOLIA_PAIR, 11155111, "SepETH"],
    [SEPOLIA_PAIR, 943, "v4tPLS"],
    [FIXTURE_PAIR, 1, "ETH"],
    [FIXTURE_PAIR, 369, "PLS"],
  ] as const)("step cost on %s chain %i reads %s", (pair, chainId, symbol) => {
    expect(stepCostText(cost(chainId), pair)).toBe(`${shortAmountText(60409100000000n, 18)} ${symbol} · —`);
  });
});

describe("the proof page reads any update from the indexer, not only the latest", () => {
  it("opens an old update by its number and links its neighbours", async () => {
    const base = createFixtureExploreSource();
    const [recorded] = await base.proofs();
    const row = (number: number) => ({ ...recorded!, number, slot: 9_000n + BigInt(number) });
    const proofByNumber = vi.fn(async (chainId: number, number: number) => ({ proof: row(number), previous: row(number - 1), next: row(number + 1) }));
    window.history.replaceState(null, "", "#/explore/proof/11155111/777");
    renderWithWallet(<Shell />, { wallet: connectedWallet(), services: { pair: SEPOLIA_PAIR, explore: { ...base, proofs: async () => [], proofByNumber } } });
    await screen.findByText("Gas used", { selector: ".zb-k" });
    expect(proofByNumber).toHaveBeenCalledWith(11155111, 777);
    expect(hrefs(screen.getByText("Previous", { selector: ".zb-k" }).parentElement as HTMLElement)).toContain("#/explore/proof/11155111/776");
    expect(hrefs(screen.getByText("Next", { selector: ".zb-k" }).parentElement as HTMLElement)).toContain("#/explore/proof/11155111/778");
  });

  it("says so when the indexer has no such update", async () => {
    window.history.replaceState(null, "", "#/explore/proof/11155111/99999");
    renderWithWallet(<Shell />, { wallet: connectedWallet(), services: { pair: SEPOLIA_PAIR, explore: { ...createFixtureExploreSource(), proofByNumber: async () => null } } });
    expect(await screen.findByText("The indexer has no such proof.")).toBeInTheDocument();
  });

  it("says so when the indexer cannot be read", async () => {
    window.history.replaceState(null, "", "#/explore/proof/11155111/5");
    renderWithWallet(<Shell />, { wallet: connectedWallet(), services: { pair: SEPOLIA_PAIR, explore: { ...createFixtureExploreSource(), proofByNumber: async () => Promise.reject(new Error("down")) } } });
    expect(await screen.findByText("The indexer could not be read.", undefined, { timeout: 5000 })).toBeInTheDocument();
  });
});
