import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { buildFixtureProver, FIXTURE_AUDIT, FIXTURE_NOW } from "@terminal/data/fixtures";
import type { AuditRow } from "@terminal/model/types";
import { AuditView } from "../../src/views/AuditView";
import { ProverView } from "../../src/views/ProverView";
import { never, renderWithServices, withDataSource } from "./support";

const matching: AuditRow = FIXTURE_AUDIT[0]!;
const tooLittleSupply: AuditRow = { ...FIXTURE_AUDIT[0]!, bridgedSupply: matching.bridgedSupply - 5_000_000n };
const tooMuchSupply: AuditRow = FIXTURE_AUDIT[2]!;

describe("the audit view", () => {
  it("says that all tokens match, with a result of Matches and a difference of 0", async () => {
    renderWithServices(<AuditView />, withDataSource({ getAudit: async () => [matching] }));
    expect(await screen.findByText("All 1 tokens match.")).toBeInTheDocument();
    const row = screen.getByText("USDC").closest("tr")!;
    expect(within(row).getByText("Matches")).toBeInTheDocument();
    expect(within(row).getAllByText("0")).toHaveLength(1);
  });

  it("flags a surplus of escrow with a plus sign and a shortage without one", async () => {
    renderWithServices(<AuditView />, withDataSource({ getAudit: async () => [tooLittleSupply, tooMuchSupply] }));
    expect(await screen.findByText(/^2 of 2 tokens do not match\./)).toBeInTheDocument();
    const surplus = screen.getByText("USDC").closest("tr")!;
    expect(within(surplus).getByText("+5")).toBeInTheDocument();
    expect(within(surplus).getByText("Mismatch")).toBeInTheDocument();
    const shortage = screen.getByText("WPLS").closest("tr")!;
    expect(within(shortage).getByText("-300")).toBeInTheDocument();
  });

  it("says Loading while the rows are in flight", () => {
    renderWithServices(<AuditView />, withDataSource({ getAudit: never }));
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("shows the error when the audit does not load", async () => {
    renderWithServices(
      <AuditView />,
      withDataSource({
        getAudit: async () => {
          throw new Error("audit boom");
        },
      }),
    );
    expect(await screen.findByText("The audit did not load: audit boom")).toBeInTheDocument();
  });
});

describe("the prover view", () => {
  it("totals the updates of each chain and lists each update with its cost and poster", async () => {
    renderWithServices(<ProverView />, withDataSource({ getProver: async () => buildFixtureProver(FIXTURE_NOW) }));
    expect(await screen.findByText("Ethereum: 1 recent updates, 118763 gas, 0.001662 ETH")).toBeInTheDocument();
    expect(screen.getByText("PulseChain: 1 recent updates, 98851 gas, 0.197702 PLS")).toBeInTheDocument();
    expect(screen.getAllByRole("row")).toHaveLength(3);
  });

  it("shows zero totals for a chain with no update", async () => {
    const onlySecond = { updates: buildFixtureProver(FIXTURE_NOW).updates.filter((update) => update.side === "second") };
    renderWithServices(<ProverView />, withDataSource({ getProver: async () => onlySecond }));
    expect(await screen.findByText("Ethereum: 0 recent updates, 0 gas, 0 ETH")).toBeInTheDocument();
  });

  it("says Loading while the updates are in flight", () => {
    renderWithServices(<ProverView />, withDataSource({ getProver: never }));
    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });

  it("shows the error when the updates do not load", async () => {
    renderWithServices(
      <ProverView />,
      withDataSource({
        getProver: async () => {
          throw new Error("prover boom");
        },
      }),
    );
    expect(await screen.findByText("The updates did not load: prover boom")).toBeInTheDocument();
  });
});
