import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FIXTURE_PAIR } from "@terminal/data/fixtures";
import type { BrowseClient, BrowseMessage } from "@zk-bridge/shared";
import { Shell } from "../../src/app/Shell";
import { createFixtureExploreSource } from "../../src/explore/explore-fixture";
import { connectedWallet, renderWithWallet } from "../app/support";

const pair = FIXTURE_PAIR;
const ADDRESS = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const NOW = 1_800_000_000;
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as const;

const row = (n: number, over: Partial<BrowseMessage>): BrowseMessage => ({
  id: hash(n),
  kind: "token",
  status: "delivered",
  sourceChainId: pair.first.chainId,
  destinationChainId: pair.second.chainId,
  sender: ADDRESS,
  recipient: ADDRESS,
  token: { chainId: pair.first.chainId, address: ADDRESS, symbol: "USDT", decimals: 6 },
  amount: 1_000_000n,
  destinationToken: null,
  fee: 1_000n,
  received: 999_000n,
  feeSource: "logs",
  sentAt: NOW - 3600,
  deliveredAt: NOW - 1800,
  sourceTransactionHash: hash(1000 + n),
  ...over,
});

describe("the fee line of a listed transfer", () => {
  it("is shown with the tokens' symbols left blank when the indexer has the fee but not the symbols", async () => {
    const symbolless = row(1, { token: { chainId: pair.first.chainId, address: ADDRESS, symbol: null, decimals: 6 }, destinationToken: { chainId: pair.second.chainId, address: ADDRESS, symbol: null, decimals: 6 } });
    const noDecimals = row(2, { destinationToken: { chainId: pair.second.chainId, address: ADDRESS, symbol: "zUSDT", decimals: null } });
    const browse = { messages: vi.fn(async () => ({ items: [symbolless, noDecimals], total: 2, limit: 50, offset: 0, asOf: NOW })), counts: vi.fn(async () => { throw new Error("no counts"); }) };
    window.history.replaceState(null, "", "#/explore/browse/transfers");
    renderWithWallet(<Shell />, { wallet: connectedWallet(), services: { pair, explore: { ...createFixtureExploreSource(), browse: browse as unknown as BrowseClient }, now: () => NOW } });
    expect(await screen.findByText(/^1\s+sent · .*fee .*received$/)).toBeTruthy();
    expect(screen.queryByText(/zUSDT fee/)).toBeNull();
  });
});
