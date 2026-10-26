import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { buildFixtureFeed, buildFixtureHeads, FIXTURE_NOW, FIXTURE_PAIR, FIXTURE_TOKENS } from "@terminal/data/fixtures";
import type { LightClientHead, PairSummary } from "@terminal/model/types";
import { HeadsFooter } from "../../src/views/pair/HeadsFooter";
import { PairView } from "../../src/views/pair/PairView";
import { SummaryBar } from "../../src/views/pair/SummaryBar";
import { ActionArea } from "../../src/views/pair/ActionArea";
import { FilterBar } from "../../src/views/pair/FilterBar";
import { EMPTY_FILTER } from "../../src/views/pair/filter-model";
import { buildTestServices, renderPage } from "../render";
import { renderWithServices, withDataSource } from "./support";

const heads = buildFixtureHeads(FIXTURE_NOW);
const [firstHead, secondHead] = [heads[0]!, heads[1]!];

const summaryOf = (overrides: Partial<PairSummary> = {}): PairSummary => ({
  pairId: "eth-pls",
  heads,
  gates: { first: "open", second: "warn" },
  inFlight: 3,
  volume24h: { transferCount: 2, byToken: [{ token: FIXTURE_TOKENS[0]!, amount: 5_000_000n }] },
  feesAccrued: [{ token: FIXTURE_TOKENS[0]!, amount: 1_250_000n }],
  ...overrides,
});

describe("the pair view", () => {
  it("says that the page has no data for a pair other than its own", () => {
    renderPage(<PairView pairId="other-pair" initialToken={null} />);
    expect(screen.getByRole("status")).toHaveTextContent("This page is set up for the pair eth-pls. It has no data for other-pair.");
  });

  it("shows a warning and Loading when the feed fails and no rows were ever loaded", async () => {
    renderWithServices(
      <PairView pairId="eth-pls" initialToken={null} />,
      withDataSource({
        getFeed: async () => {
          throw new Error("feed boom");
        },
      }),
    );
    expect(await screen.findByText("The feed did not refresh (feed boom). The rows are the last good ones.")).toBeInTheDocument();
    expect(screen.getByText("Loading the feed…")).toBeInTheDocument();
  });

  it("offers older rows when the feed has more, and asks for a page twice as long", async () => {
    const getFeed = vi.fn(async (_pairId: string, _filter: unknown, limit: number) => ({ items: buildFixtureFeed(FIXTURE_NOW).slice(0, 3), hasMore: limit === 50 }));
    renderWithServices(<PairView pairId="eth-pls" initialToken={null} />, withDataSource({ getFeed }));
    await userEvent.click(await screen.findByRole("button", { name: "Show older rows" }));
    await waitFor(() => expect(getFeed).toHaveBeenLastCalledWith("eth-pls", expect.anything(), 100));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Show older rows" })).toBeNull());
  });

  it("goes back to the first page of rows when a filter changes", async () => {
    const getFeed = vi.fn(async (_pairId: string, _filter: unknown, limit: number) => ({ items: buildFixtureFeed(FIXTURE_NOW).slice(0, 3), hasMore: limit === 50 }));
    renderWithServices(<PairView pairId="eth-pls" initialToken={null} />, withDataSource({ getFeed }));
    await userEvent.click(await screen.findByRole("button", { name: "Show older rows" }));
    await waitFor(() => expect(getFeed).toHaveBeenCalledWith("eth-pls", expect.anything(), 100));
    await userEvent.selectOptions(screen.getByLabelText("Kind"), "message");
    await waitFor(() => expect(getFeed).toHaveBeenLastCalledWith("eth-pls", expect.objectContaining({ kind: "message" }), 50));
  });

  it("reads no balances when no wallet is connected", async () => {
    const readSnapshots = vi.fn(async () => []);
    renderWithServices(<PairView pairId="eth-pls" initialToken={null} />, { chainAccess: { ...buildTestServices().chainAccess, readSnapshots } }, undefined, { connected: false });
    await screen.findByRole("table", { name: "Transfers and messages" });
    expect(readSnapshots).not.toHaveBeenCalled();
  });

  it("warns about an address that is not an address yet, and does not filter by it", async () => {
    const getFeed = vi.fn(async (_pairId: string, _filter: unknown, _limit: number) => ({ items: [], hasMore: false }));
    renderWithServices(<PairView pairId="eth-pls" initialToken={null} />, withDataSource({ getFeed }));
    await userEvent.type(screen.getByLabelText("Address"), "0x12");
    expect(await screen.findByRole("alert")).toHaveTextContent("This is not an address yet. The feed is not filtered by it.");
    expect(await screen.findByText("No transfers or messages match these filters.")).toBeInTheDocument();
    for (const call of getFeed.mock.calls) expect(call[1]).not.toHaveProperty("address", "0x12");
  });
});

describe("the heads footer", () => {
  it("says that a chain stores no head of the other chain while the heads are unknown", () => {
    renderPage(<HeadsFooter pair={FIXTURE_PAIR} heads={undefined} now={FIXTURE_NOW} />);
    expect(screen.getByText("Ethereum stores no head of PulseChain yet.")).toBeInTheDocument();
    expect(screen.getByText("PulseChain stores no head of Ethereum yet.")).toBeInTheDocument();
  });

  it("shows the head, the finalized slot, the lag and the age of the last update of each chain", () => {
    renderPage(<HeadsFooter pair={FIXTURE_PAIR} heads={heads} now={FIXTURE_NOW} />);
    const footer = screen.getByRole("contentinfo", { name: "Light client heads" });
    expect(footer).toHaveTextContent("Ethereum stores PulseChain: head 25,800,000, finalized 25,800,096, lag 96 slots (16m 00s), updated");
    expect(footer).toHaveTextContent("PulseChain stores Ethereum: head 14,100,000, finalized 14,100,064, lag 64 slots (12m 48s), updated");
  });

  it("says none, unknown and never for a head that the indexer has not seen", () => {
    const empty: LightClientHead = { ...firstHead, storedHeadSlot: null, finalizedSlot: null, lagSlots: null, lastUpdateAt: null };
    renderPage(<HeadsFooter pair={FIXTURE_PAIR} heads={[empty, secondHead]} now={FIXTURE_NOW} />);
    expect(screen.getByRole("contentinfo")).toHaveTextContent("Ethereum stores PulseChain: head none, finalized unknown, lag unknown, updated never");
  });

  it("colors the lag by its severity", () => {
    const warning: LightClientHead = { ...firstHead, lagSlots: 400n, secondsPerSlot: 10 };
    const bad: LightClientHead = { ...secondHead, lagSlots: 4_000n, secondsPerSlot: 12 };
    renderPage(<HeadsFooter pair={FIXTURE_PAIR} heads={[warning, bad]} now={FIXTURE_NOW} />);
    const lagOf = (text: string) => screen.getByText(text);
    expect(lagOf("400 slots (1h 06m 40s)")).toBeInTheDocument();
    expect(lagOf("4,000 slots (13h 20m 00s)")).toBeInTheDocument();
    expect(getComputedStyle(lagOf("400 slots (1h 06m 40s)")).color).not.toBe(getComputedStyle(lagOf("4,000 slots (13h 20m 00s)")).color);
  });
});

describe("the summary bar", () => {
  it("says Loading the summary while it is in flight", () => {
    renderPage(<SummaryBar pair={FIXTURE_PAIR} summary={undefined} error={null} now={FIXTURE_NOW} />);
    expect(screen.getByText("Loading the summary…")).toBeInTheDocument();
  });

  it("shows the error when no summary ever loaded", () => {
    renderPage(<SummaryBar pair={FIXTURE_PAIR} summary={undefined} error="summary boom" now={FIXTURE_NOW} />);
    expect(screen.getByRole("alert")).toHaveTextContent("The summary did not load: summary boom");
  });

  it("shows the numbers, the gate in words on each chain, and the age of the newest head update", () => {
    renderPage(<SummaryBar pair={FIXTURE_PAIR} summary={summaryOf()} error={null} now={FIXTURE_NOW} />);
    const list = screen.getByLabelText("Summary");
    expect(list).toHaveTextContent("Paireth-pls: Ethereum and PulseChain");
    expect(list).toHaveTextContent("In flight3");
    expect(list).toHaveTextContent("Volume, 24 hours2 transfers, 5 USDC");
    expect(list).toHaveTextContent("Fees accrued1.25 USDC");
    expect(list).toHaveTextContent("Gate on Ethereumopen");
    expect(list).toHaveTextContent("Gate on PulseChainnot enforcing yet");
    expect(list).toHaveTextContent("Last light client update14m ago");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("says none for no fees, no volume and no update, and names every gate word", () => {
    const empty = summaryOf({ heads: [], volume24h: { transferCount: 0, byToken: [] }, feesAccrued: [] });
    const first = renderPage(<SummaryBar pair={FIXTURE_PAIR} summary={{ ...empty, gates: { first: "stop", second: "sealed" } }} error={null} now={FIXTURE_NOW} />);
    const list = () => screen.getByLabelText("Summary");
    expect(list()).toHaveTextContent("Volume, 24 hours0 transfers");
    expect(list()).not.toHaveTextContent("0 transfers,");
    expect(list()).toHaveTextContent("Fees accruednone");
    expect(list()).toHaveTextContent("Last light client updatenone seen");
    expect(list()).toHaveTextContent("Gate on Ethereumsends closed");
    expect(list()).toHaveTextContent("Gate on PulseChainsealed");
    first.unmount();
    renderPage(<SummaryBar pair={FIXTURE_PAIR} summary={{ ...empty, gates: { first: "stale", second: "unknown" } }} error={null} now={FIXTURE_NOW} />);
    expect(list()).toHaveTextContent("Gate on Ethereumstale");
    expect(list()).toHaveTextContent("Gate on PulseChainunknown");
  });

  it("takes the newest update among the heads that have one", () => {
    const unseen: LightClientHead = { ...firstHead, lastUpdateAt: null };
    renderPage(<SummaryBar pair={FIXTURE_PAIR} summary={summaryOf({ heads: [unseen, { ...secondHead, lastUpdateAt: FIXTURE_NOW - 3_600 }] })} error={null} now={FIXTURE_NOW} />);
    expect(screen.getByLabelText("Summary")).toHaveTextContent("Last light client update1h ago");
  });

  it("keeps the last good numbers and warns when a refresh failed", () => {
    renderPage(<SummaryBar pair={FIXTURE_PAIR} summary={summaryOf()} error="refresh boom" now={FIXTURE_NOW} />);
    expect(screen.getByRole("status")).toHaveTextContent("The last refresh failed (refresh boom). The numbers below are the last good ones.");
    expect(screen.getByLabelText("Summary")).toHaveTextContent("In flight3");
  });
});

describe("the action area", () => {
  it("opens the dialog of each action, and counts the claims in the label", async () => {
    const open = vi.fn();
    const { chainAccess } = buildTestServices();
    const snapshots = await chainAccess.readSnapshots({ account: "0x000000000000000000000000000000000000ABC0", tokens: FIXTURE_TOKENS });
    renderPage(<ActionArea pair={FIXTURE_PAIR} snapshots={snapshots} snapshotError={null} />, { actions: { open } });
    for (const [name, dialog] of [[/Bridge tokens/, "bridge"], [/Wrap the native coin/, "wrap"], [/Send a message/, "message"], [/Claim balances \(1\)/, "claim"]] as const) {
      await userEvent.click(screen.getByRole("button", { name }));
      expect(open).toHaveBeenLastCalledWith(dialog);
    }
    expect(open).toHaveBeenCalledTimes(4);
  });

  it("shows Claim balances with no count when nothing is claimable", () => {
    renderPage(<ActionArea pair={FIXTURE_PAIR} snapshots={undefined} snapshotError={null} />);
    expect(screen.getByRole("button", { name: "Claim balances" })).toBeEnabled();
  });
});

describe("the filter bar", () => {
  it("counts the active filters in the label of the clear button, in singular and plural, and clears them", async () => {
    const onChange = vi.fn();
    const idle = renderPage(<FilterBar pair={FIXTURE_PAIR} tokens={FIXTURE_TOKENS} state={EMPTY_FILTER} onChange={onChange} addressProblem={null} />);
    expect(screen.getByRole("button", { name: "Clear filters" })).toBeDisabled();
    idle.unmount();
    const one = renderPage(<FilterBar pair={FIXTURE_PAIR} tokens={FIXTURE_TOKENS} state={{ ...EMPTY_FILTER, kind: "token" }} onChange={onChange} addressProblem={null} />);
    expect(screen.getByRole("button", { name: "Clear 1 filter" })).toBeEnabled();
    one.unmount();
    renderPage(<FilterBar pair={FIXTURE_PAIR} tokens={FIXTURE_TOKENS} state={{ ...EMPTY_FILTER, kind: "token", status: "failed_call" }} onChange={onChange} addressProblem={null} />);
    await userEvent.click(screen.getByRole("button", { name: "Clear 2 filters" }));
    expect(onChange).toHaveBeenCalledWith(EMPTY_FILTER);
  });

  it("does not submit the page when Enter is pressed in the form", () => {
    renderPage(<FilterBar pair={FIXTURE_PAIR} tokens={FIXTURE_TOKENS} state={EMPTY_FILTER} onChange={() => undefined} addressProblem={null} />);
    expect(fireEvent.submit(screen.getByRole("search", { name: "Feed filters" }))).toBe(false);
  });

  it("reports each control change with the new value and keeps the others", async () => {
    const onChange = vi.fn();
    renderPage(<FilterBar pair={FIXTURE_PAIR} tokens={FIXTURE_TOKENS} state={EMPTY_FILTER} onChange={onChange} addressProblem={null} />);
    await userEvent.selectOptions(screen.getByLabelText("Time range"), "7d");
    expect(onChange).toHaveBeenLastCalledWith({ ...EMPTY_FILTER, range: "7d" });
    await userEvent.selectOptions(screen.getByLabelText("Direction"), "first-to-second");
    expect(onChange).toHaveBeenLastCalledWith({ ...EMPTY_FILTER, direction: "first-to-second" });
    await userEvent.type(screen.getByLabelText("Address"), "a");
    expect(onChange).toHaveBeenLastCalledWith({ ...EMPTY_FILTER, address: "a" });
    expect(within(screen.getByLabelText("Token")).getAllByRole("option")).toHaveLength(FIXTURE_TOKENS.length + 1);
  });
});
