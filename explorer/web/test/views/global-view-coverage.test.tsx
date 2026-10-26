import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { buildFixtureHeads, FIXTURE_NOW } from "@terminal/data/fixtures";
import type { PairHealth } from "@terminal/model/types";
import { GlobalView } from "../../src/views/GlobalView";
import { buildTestServices } from "../render";
import { never, renderWithServices, withDataSource } from "./support";

const health = (overrides: Partial<PairHealth> = {}): PairHealth => ({
  pairId: "eth-pls",
  label: "Ethereum and PulseChain",
  firstChainName: "Ethereum",
  secondChainName: "PulseChain",
  heads: buildFixtureHeads(FIXTURE_NOW),
  gates: { first: "open", second: "stop" },
  inFlight: 7,
  lastActivityAt: FIXTURE_NOW - 90,
  ...overrides,
});

describe("the global view", () => {
  it("shows one row per pair with the lag, the gate and the age of the last activity", async () => {
    renderWithServices(<GlobalView />, withDataSource({ listPairs: async () => [health()] }));
    const link = await screen.findByRole("link", { name: "eth-pls" });
    expect(link).toHaveAttribute("href", "#/pair/eth-pls");
    const row = link.closest("tr")!;
    expect(within(row).getAllByText("Ethereum and PulseChain")).toHaveLength(2);
    expect(within(row).getByText("Ethereum: lag 96 slots (16m 00s)")).toBeInTheDocument();
    expect(within(row).getByText("PulseChain: lag 64 slots (12m 48s)")).toBeInTheDocument();
    expect(within(row).getByText("Ethereum: open")).toBeInTheDocument();
    expect(within(row).getByText("PulseChain: stop")).toBeInTheDocument();
    expect(within(row).getByText("7")).toBeInTheDocument();
  });

  it("says no head for a chain that has no head, and none seen for a pair with no activity", async () => {
    const heads = buildFixtureHeads(FIXTURE_NOW).filter((head) => head.side === "first");
    renderWithServices(<GlobalView />, withDataSource({ listPairs: async () => [health({ heads, lastActivityAt: null })] }));
    expect(await screen.findByText("PulseChain: no head")).toBeInTheDocument();
    expect(screen.getByText("none seen")).toBeInTheDocument();
  });

  it("says Loading in the row of the configured pair while the health is in flight", () => {
    renderWithServices(<GlobalView />, withDataSource({ listPairs: never }));
    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });

  it("says that a pair is not configured when the page has no deployment file for it", () => {
    const base = buildTestServices();
    renderWithServices(<GlobalView />, { knownPairs: [{ id: "other-pair", label: "Other", configured: false }], dataSource: { ...base.dataSource, listPairs: async () => [health({ pairId: "other-pair" })] } });
    expect(screen.getByText("Not configured on this page. Set a deployment file for it.")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "other-pair" })).toBeNull();
  });

  it("shows the error when the health does not load", async () => {
    renderWithServices(
      <GlobalView />,
      withDataSource({
        listPairs: async () => {
          throw new Error("health boom");
        },
      }),
    );
    expect(await screen.findByText("The pair health did not load: health boom")).toBeInTheDocument();
  });
});
