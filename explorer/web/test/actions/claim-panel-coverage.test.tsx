import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { FIXTURE_ACCOUNT, FIXTURE_PAIR } from "@terminal/data/fixtures";
import type { ChainSnapshotResult } from "@terminal/chain/live-reads";
import { ClaimPanel } from "../../src/actions/ClaimPanel";
import type { WebStep } from "../../src/tx/bridge-steps";
import { buildFixtureContext } from "../helpers";
import { renderPage } from "../render";

/** The fixture snapshots, with a claimable amount of the first token of the second chain. */
const withSecondChainClaim = async (claimable: bigint): Promise<readonly ChainSnapshotResult[]> => {
  const { context } = await buildFixtureContext();
  return (context.snapshots ?? []).map((result) =>
    result.status === "ok" && result.snapshot.chain.side === "second"
      ? { ...result, snapshot: { ...result.snapshot, positions: result.snapshot.positions.map((position, index) => (index === 0 ? { ...position, claimable } : position)) } }
      : result,
  );
};

describe("the claim panel", () => {
  it("says that nothing is claimable when there are no snapshots", () => {
    renderPage(<ClaimPanel pair={FIXTURE_PAIR} snapshots={null} account={FIXTURE_ACCOUNT} onReview={() => undefined} />);
    expect(screen.getByText("Nothing is claimable for this account on either chain.")).toBeInTheDocument();
  });

  it("says that nothing is claimable when every claimable amount is zero", async () => {
    const { context } = await buildFixtureContext();
    const zeroed = (context.snapshots ?? []).map((result) =>
      result.status === "ok" ? { ...result, snapshot: { ...result.snapshot, positions: result.snapshot.positions.map((position) => ({ ...position, claimable: 0n })) } } : result,
    );
    renderPage(<ClaimPanel pair={FIXTURE_PAIR} snapshots={zeroed} account={FIXTURE_ACCOUNT} onReview={() => undefined} />);
    expect(screen.getByText("Nothing is claimable for this account on either chain.")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("lists a claim on each chain with the name of that chain, and reviews the claim of the chain that the button names", async () => {
    const onReview = vi.fn();
    const snapshots = await withSecondChainClaim(7_000_000n);
    renderPage(<ClaimPanel pair={FIXTURE_PAIR} snapshots={snapshots} account={FIXTURE_ACCOUNT} onReview={onReview} />);
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(within(items[0]!).getByText("on Ethereum")).toBeInTheDocument();
    expect(within(items[0]!).getByText("25 USDC")).toBeInTheDocument();
    expect(within(items[1]!).getByText("on PulseChain")).toBeInTheDocument();
    expect(within(items[1]!).getByText("7 zkbUSDC")).toBeInTheDocument();

    await userEvent.click(within(items[1]!).getByRole("button", { name: "Claim zkbUSDC" }));
    expect(onReview).toHaveBeenCalledTimes(1);
    const steps = onReview.mock.calls[0]![0] as readonly WebStep[];
    expect(steps).toHaveLength(1);
    expect(steps[0]!.plan.chain.chainId).toBe(FIXTURE_PAIR.second.chainId);
    expect(steps[0]!.plan.functionName).toBe("claim");
    expect(steps[0]!.disclosure.delivery).toBeNull();
    expect(steps[0]!.disclosure.bridgeFees).toBeNull();
  });

  it("reviews the claim of the first chain on the first chain", async () => {
    const onReview = vi.fn();
    const { context } = await buildFixtureContext();
    renderPage(<ClaimPanel pair={FIXTURE_PAIR} snapshots={context.snapshots} account={FIXTURE_ACCOUNT} onReview={onReview} />);
    await userEvent.click(screen.getByRole("button", { name: "Claim USDC" }));
    const steps = onReview.mock.calls[0]![0] as readonly WebStep[];
    expect(steps[0]!.plan.chain.chainId).toBe(FIXTURE_PAIR.first.chainId);
  });
});
