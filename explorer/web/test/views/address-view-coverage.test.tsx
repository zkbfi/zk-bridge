import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FIXTURE_ACCOUNT, FIXTURE_PAIR, FIXTURE_TOKENS } from "@terminal/data/fixtures";
import type { ChainSnapshotResult } from "@terminal/chain/live-reads";
import { buildTestServices } from "../render";
import { AddressView } from "../../src/views/AddressView";
import { never, renderWithServices, withDataSource } from "./support";

const chainAccessOf = (readSnapshots: () => Promise<readonly ChainSnapshotResult[]>) => ({ ...buildTestServices().chainAccess, readSnapshots });

const secondChainUsdc = FIXTURE_TOKENS[1]!;

const snapshotsWith = (claimableOnSecond: bigint, claimableOnFirst: bigint): readonly ChainSnapshotResult[] => [
  { status: "ok", snapshot: { chain: FIXTURE_PAIR.first, nativeBalance: 0n, positions: [{ token: FIXTURE_TOKENS[0]!, balance: 0n, allowance: 0n, claimable: claimableOnFirst }] } },
  { status: "ok", snapshot: { chain: FIXTURE_PAIR.second, nativeBalance: 5n * 10n ** 18n, positions: [{ token: secondChainUsdc, balance: 1_500_000n, allowance: 0n, claimable: claimableOnSecond }] } },
];

describe("the address view", () => {
  it("shows the balances of both chains, what can be claimed and the feed of the address", async () => {
    renderWithServices(<AddressView address={FIXTURE_ACCOUNT} />);
    const balances = screen.getByRole("region", { name: "Balances" });
    expect(await within(balances).findByText("12 ETH")).toBeInTheDocument();
    expect(within(balances).getByText("12 PLS")).toBeInTheDocument();
    expect(screen.getByText(FIXTURE_ACCOUNT)).toBeInTheDocument();
    expect(await screen.findByText("25 USDC on Ethereum")).toBeInTheDocument();
    expect(await screen.findByRole("table", { name: "Transfers and messages" })).toBeInTheDocument();
  });

  it("names the second chain for a claim on the second chain, and says when nothing is claimable", async () => {
    const first = renderWithServices(<AddressView address={FIXTURE_ACCOUNT} />, { chainAccess: chainAccessOf(async () => snapshotsWith(2_000_000n, 0n)) });
    expect(await screen.findByText("2 zkbUSDC on PulseChain")).toBeInTheDocument();
    first.unmount();
    renderWithServices(<AddressView address={FIXTURE_ACCOUNT} />, { chainAccess: chainAccessOf(async () => snapshotsWith(0n, 0n)) });
    expect(await screen.findByText("Nothing is claimable for this address.")).toBeInTheDocument();
  });

  it("says Loading while the balances and the feed are in flight", () => {
    renderWithServices(<AddressView address={FIXTURE_ACCOUNT} />, { chainAccess: chainAccessOf(never), ...withDataSource({ getFeed: never }) });
    expect(screen.getAllByText("Loading…")).toHaveLength(2);
  });

  it("shows the reason when one chain cannot be read, and still shows the other chain", async () => {
    const results: readonly ChainSnapshotResult[] = [
      { status: "error", chain: FIXTURE_PAIR.first, message: "rpc down" },
      snapshotsWith(0n, 0n)[1]!,
    ];
    renderWithServices(<AddressView address={FIXTURE_ACCOUNT} />, { chainAccess: chainAccessOf(async () => results) });
    expect(await screen.findByText("Ethereum: rpc down")).toBeInTheDocument();
    expect(screen.getByText("5 PLS")).toBeInTheDocument();
    expect(screen.getByText("1.5 zkbUSDC")).toBeInTheDocument();
  });

  it("shows the error when the balances do not load or the feed does not load", async () => {
    renderWithServices(<AddressView address={FIXTURE_ACCOUNT} />, {
      chainAccess: chainAccessOf(async () => {
        throw new Error("balances boom");
      }),
      ...withDataSource({
        getFeed: async () => {
          throw new Error("feed boom");
        },
      }),
    });
    expect(await screen.findByText("Balances did not load: balances boom")).toBeInTheDocument();
    expect(await screen.findByText("The feed did not load: feed boom")).toBeInTheDocument();
  });
});
