import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FIXTURE_PAIR, FIXTURE_TOKENS } from "@terminal/data/fixtures";
import type { FeedItem, LightClientHead } from "@terminal/model/types";
import type { BrowseCounts } from "@zk-bridge/shared";
import { createFixtureExploreSource } from "../../src/explore/explore-fixture";
import { ExploreScreen } from "../../src/explore/ExploreScreen";
import { buildDeliveryReport } from "../helpers";
import { buildTestServices } from "../render";
import { connectedWallet, renderWithWallet } from "../app/support";

// The orbits are drawn by their own component (tested apart); here the screen's input to them is what counts.
const orbits = vi.hoisted(() => ({ props: null as null | { tracks: readonly never[]; loading: boolean; fetching: number } }));
vi.mock("../../src/explore/InFlightOrbits", () => ({
  InFlightOrbits: (props: { tracks: readonly never[]; loading: boolean; fetching: number }) => {
    orbits.props = props;
    return <div data-testid="orbits" />;
  },
}));
// The prices come from a controllable map (a live page would read PulseChain's pools).
const price = vi.hoisted(() => ({ map: undefined as undefined | Map<string, { usdE18: bigint; block: bigint; pool: null } | null> }));
vi.mock("../../src/bridge/use-prices", async (original) => {
  const actual = await original<typeof import("../../src/bridge/use-prices")>();
  return { ...actual, usePrices: () => ({ data: price.map, states: new Map(), error: null, isError: false, isFetching: false }) };
});
// The latest proof of each direction comes from a fake of the msgboard reads.
const latest = vi.hoisted(() => ({ calls: [] as { direction: string; headSlot: bigint | null; boardChainId: number | undefined }[], reading: (_direction: string): unknown => ({ kind: "none", notes: [] }) }));
vi.mock("../../src/views/proof-panel-model", async (original) => {
  const actual = await original<typeof import("../../src/views/proof-panel-model")>();
  return {
    ...actual,
    readLatestProof: async (input: { direction: string; headSlot: bigint | null; boardChainId?: number }) => {
      latest.calls.push({ direction: input.direction, headSlot: input.headSlot, boardChainId: input.boardChainId });
      return latest.reading(input.direction);
    },
  };
});

const pair = FIXTURE_PAIR;
const base = buildTestServices();
const NOW = base.now();
const quote = (usd: bigint) => ({ usdE18: usd * 10n ** 18n, block: 0n, pool: null });
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as const;
const item = (n: number, over: Partial<FeedItem>): FeedItem => ({
  id: hash(n), kind: "token", direction: "first-to-second", status: "sent",
  sender: "0x0000000000000000000000000000000000000001", recipient: "0x0000000000000000000000000000000000000002",
  token: FIXTURE_TOKENS[0]!, amount: 1_000_000n, sentAt: NOW - 100, deliveredAt: null, sourceTransactionHash: hash(900 + n), destinationTransactionHash: null, ...over,
});

const render = (services: Record<string, unknown> = {}) =>
  renderWithWallet(<ExploreScreen route={{ name: "explore" }} onRoute={() => undefined} />, { wallet: connectedWallet(), services: { pair, ...services } as never });
const live = { configuration: { ...base.configuration, dataMode: "live" as const, rpcUrls: {}, indexerUrl: null, backendUrl: null, archiveUrl: null } };

beforeEach(() => {
  window.localStorage.clear();
  orbits.props = null;
  price.map = undefined;
  latest.calls = [];
  latest.reading = () => ({ kind: "none", notes: [] });
});

describe("the orbits' input, live", () => {
  it("reads each direction's latest proof with the stored head of the destination, and a proof covers the sends before its slot", async () => {
    const feeds: Record<string, FeedItem[]> = {
      sent: [item(1, { sentAt: 2000 }), item(2, { sentAt: 3000 }), item(3, { direction: "second-to-first", sentAt: 2000 })],
      waiting_for_finality: [],
      covered: [item(4, { status: "covered" })],
      delivered: [],
    };
    latest.reading = (direction) => (direction === "first-to-second" ? { kind: "found", source: "msgboard node", message: { newSlot: 100n }, headCheckedAt: null, notes: [] } : { kind: "none", notes: [] });
    const heads: readonly LightClientHead[] = [
      { side: "first", storedHeadSlot: null, finalizedSlot: null, lagSlots: null, secondsPerSlot: 12, lastUpdateAt: null },
      { side: "second", storedHeadSlot: 777n, finalizedSlot: 800n, lagSlots: 23n, secondsPerSlot: 12, lastUpdateAt: NOW - 5 },
    ];
    const dataSource = {
      ...base.dataSource,
      getHeads: async () => heads,
      getFeed: async (_id: string, filter: { status?: string }) => ({ items: feeds[filter.status ?? ""] ?? [], hasMore: false }),
    };
    const explore = {
      ...createFixtureExploreSource(),
      // Genesis 1,000 and 12 s slots: a proof whose new slot is 100 reaches 2,200.
      beaconClocks: async () => [{ trackedChainId: pair.first.chainId, genesisTime: 1000, secondsPerSlot: 12 }],
      delivered: async () => [{ sourceChainId: pair.first.chainId, last24h: 3, last7d: 9, timing: null }, { sourceChainId: pair.second.chainId, last24h: 1, last7d: 2, timing: null }],
    };
    render({ ...live, dataSource, explore });
    await waitFor(() => expect(latest.calls.length).toBeGreaterThanOrEqual(2));
    await waitFor(() => {
      const [out] = orbits.props!.tracks as unknown as { counts: number[]; delivered24h: number }[];
      expect(out!.counts).toEqual([1, 0, 2]);
      expect(out!.delivered24h).toBe(3);
    });
    const [out, back] = orbits.props!.tracks as unknown as { counts: number[]; delivered7d: number }[];
    expect(back!.counts).toEqual([1, 0, 0]);
    expect(back!.delivered7d).toBe(2);
    expect(latest.calls).toContainEqual({ direction: "first-to-second", headSlot: 777n, boardChainId: pair.second.chainId });
    expect(latest.calls).toContainEqual({ direction: "second-to-first", headSlot: null, boardChainId: pair.first.chainId });
    expect(orbits.props!.loading).toBe(false);
  });

  it("waits for the three lists before drawing, and counts the requests that are out", async () => {
    const never = new Promise<never>(() => undefined);
    render({ ...live, dataSource: { ...base.dataSource, getFeed: async (_id: string, filter: { status?: string }) => (filter.status === "sent" ? never : { items: [], hasMore: false }) } });
    await waitFor(() => expect(orbits.props).not.toBeNull());
    expect(orbits.props!.loading).toBe(true);
    await waitFor(() => expect(orbits.props!.fetching).toBeGreaterThan(0));
  });

  it("prices a transfer by its token, and puts the delivery's gas cost on each direction only when its inputs are known", async () => {
    price.map = new Map([
      [`first:${FIXTURE_TOKENS[0]!.address}`, quote(2n)],
      [`native:${pair.first.chainId}`, quote(3000n)],
      [`native:${pair.second.chainId}`, null],
    ]);
    const feed = { sent: [item(1, { amount: 5_000_000n }), item(2, { token: { ...FIXTURE_TOKENS[0]!, address: "0x00000000000000000000000000000000000000ee" }, amount: 1n })] } as Record<string, FeedItem[]>;
    const dataSource = {
      ...base.dataSource,
      getFeed: async (_id: string, filter: { status?: string }) => ({ items: feed[filter.status ?? ""] ?? [], hasMore: false }),
      getDeliveryCost: async (chainId: number) => buildDeliveryReport(chainId, { p90Gas: 100_000n }),
    };
    const chainAccess = { ...base.chainAccess, flowClient: () => ({ estimateFeesPerGas: async () => ({ maxPriorityFeePerGas: 2_000_000_000n }) }) };
    render({ ...live, dataSource, chainAccess });
    await waitFor(() => {
      const [out] = orbits.props!.tracks as unknown as { deliveryGasUsd: number | null; planets: { usd: number | null }[] }[];
      expect(out!.planets.map((planet) => planet.usd)).toEqual([10, null]);
    });
    const [out, back] = orbits.props!.tracks as unknown as { deliveryGasUsd: number | null }[];
    // The destination of the outbound direction is the second chain, which has no native price: unknown.
    expect(out!.deliveryGasUsd).toBeNull();
    expect(back!.deliveryGasUsd).not.toBeNull();
  });

  it("estimates a delivery from the measured p90, else the average, else the default gas", async () => {
    price.map = new Map([[`native:${pair.first.chainId}`, quote(3000n)], [`native:${pair.second.chainId}`, quote(3000n)]]);
    const report = (chainId: number) => {
      const built = buildDeliveryReport(chainId);
      return chainId === pair.first.chainId
        ? { ...built, kinds: { ...built.kinds, token: { ...built.kinds.token, p90Gas: null, averageGas: 150_000n, isDefault: false } } }
        : built;
    };
    render({ ...live, dataSource: { ...base.dataSource, getDeliveryCost: async (chainId: number) => report(chainId) } });
    await waitFor(() => {
      const [out, back] = orbits.props!.tracks as unknown as { deliveryGasUsd: number | null }[];
      expect(out!.deliveryGasUsd).not.toBeNull();
      expect(back!.deliveryGasUsd).not.toBeNull();
    });
    const [out, back] = orbits.props!.tracks as unknown as { deliveryGasUsd: number }[];
    // Deliveries to the second chain use the default gas (300,000 against the average 150,000 on the first).
    expect(out!.deliveryGasUsd).toBeGreaterThan(back!.deliveryGasUsd);
  });
});

describe("the browse tiles", () => {
  const counts = (over: Partial<BrowseCounts> = {}): BrowseCounts => ({
    asOf: NOW,
    messages: { total: 1284, inFlight: 3, transfers: 1200, plain: 84, byStatus: {}, directions: [] },
    lightClientUpdates: { total: 221, chains: [] },
    addresses: { total: 412, senders: 200, recipients: 300, posters: 2 },
    tokens: { total: 9, chains: [] },
    contracts: 12,
    gates: { total: 2, open: 1 },
    escrow: { entries: 5 },
    ...over,
  });
  const tile = async (title: string) => (await screen.findByText(title)).closest("a")!;

  it("show the indexer's all-time counts", async () => {
    render({ explore: { ...createFixtureExploreSource(), browse: { counts: async () => counts() } } });
    await waitFor(async () => expect((await tile("Transfers & messages")).querySelector(".zb-tile-n")).toHaveTextContent("1,284"));
    expect((await tile("Gates & escrow")).querySelector(".zb-tile-s")).toHaveTextContent("1 open · 5 escrowed");
  });

  it("fall back to what the page loaded, labelled, when the indexer has no counts, and count the escrow from its list", async () => {
    render({ explore: { ...createFixtureExploreSource(), browse: { counts: async () => { throw new Error("no counts"); } }, counts: async () => ({ escrowed: 4, undelivered: 0, releases: 2 }) } });
    // The failed read is tried once more before the tiles give up on the counts.
    await waitFor(async () => expect((await tile("Transfers & messages")).querySelector(".zb-tile-s")).toHaveTextContent(/^latest \d+ · \d+ in flight$/), { timeout: 8000 });
    expect((await tile("Gates & escrow")).querySelector(".zb-tile-s")).toHaveTextContent(/ · 4 escrowed$/);
    expect((await tile("Releases")).querySelector(".zb-tile-n")).toHaveTextContent("2");
  });

  it("say what the cost of a proof is from the first chain's updates, or the second's", async () => {
    const costs = (chainId: number) => ({ explore: { ...createFixtureExploreSource(), lightClientCosts: async () => [{ chainId, updates: 2, gasUsed: 10n, costWei: 4_000_000_000_000_000_000n }] } });
    const first = render(costs(pair.first.chainId));
    await waitFor(async () => expect((await tile("Costs")).querySelector(".zb-tile-s")).toHaveTextContent(`${pair.first.nativeSymbol} per proof · 2 posted`));
    first.unmount();
    render(costs(pair.second.chainId));
    await waitFor(async () => expect((await tile("Costs")).querySelector(".zb-tile-s")).toHaveTextContent(`${pair.second.nativeSymbol} per proof · 2 posted`));
  });

  it("show dashes while nothing has arrived and no cost when no proof was posted", async () => {
    render({ explore: { ...createFixtureExploreSource(), lightClientCosts: async () => [], counts: () => new Promise(() => undefined), browse: { counts: () => new Promise(() => undefined) } } });
    expect((await tile("Transfers & messages")).querySelector(".zb-tile-n")).toHaveTextContent("—");
    expect((await tile("Transfers & messages")).querySelector(".zb-tile-s")).toHaveTextContent("counting…");
    expect((await tile("Costs")).querySelector(".zb-tile-s")).toHaveTextContent("per proof");
    expect((await tile("Releases")).querySelector(".zb-tile-n")).toHaveTextContent("—");
  });
});

describe("the light clients", () => {
  it("say how far behind each is, that nothing is verified yet, and that it never updated", async () => {
    const heads: readonly LightClientHead[] = [
      { side: "first", storedHeadSlot: null, finalizedSlot: null, lagSlots: null, secondsPerSlot: 12, lastUpdateAt: null },
      { side: "second", storedHeadSlot: 500n, finalizedSlot: 800n, lagSlots: 400n, secondsPerSlot: 12, lastUpdateAt: NOW - 3000 },
    ];
    render({ dataSource: { ...base.dataSource, getHeads: async () => heads } });
    expect(await screen.findByText("Nothing verified yet")).toBeInTheDocument();
    expect(screen.getByText("never updated")).toBeInTheDocument();
    expect(screen.getByText("Verified up to slot 500")).toBeInTheDocument();
    expect(screen.getByText(/ behind$/).className).toContain("zb-warn-text");
    expect(screen.getByText("lag unknown")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Verified up to slot 500/ })).toHaveAttribute("href", "#/explore/slot/500");
  });
});

describe("the services", () => {
  it("name the host of each service the page is configured with, a setting that is not a URL, and a service that is not set", async () => {
    const configuration = { ...live.configuration, indexerUrl: "https://indexer.test/api", backendUrl: "not a url", archiveUrl: null, rpcUrls: { [pair.first.chainId]: "https://rpc1.test/key" } };
    render({ configuration });
    expect(await screen.findByText("indexer.test")).toBeInTheDocument();
    expect(screen.getByText("not a URL")).toBeInTheDocument();
    expect(screen.getByText("rpc1.test")).toBeInTheDocument();
    expect(screen.getAllByText("not set").length).toBeGreaterThanOrEqual(1);
  });

  it("prefer what the connections settings resolve to", async () => {
    const connection = {
      resolved: () => ({
        indexerUrl: { value: "https://settings-indexer.test" },
        backendUrl: { value: "https://settings-prover.test" },
        archiveUrl: { value: "https://settings-archive.test" },
        rpcUrls: { [pair.first.chainId]: { value: "https://settings-rpc1.test" }, [pair.second.chainId]: { value: "https://settings-rpc2.test" } },
      }),
    };
    render({ ...live, connection });
    for (const host of ["settings-indexer.test", "settings-prover.test", "settings-archive.test", "settings-rpc1.test", "settings-rpc2.test"]) expect(await screen.findByText(host)).toBeInTheDocument();
  });

  it("fall back to the configuration's settings when the connections have none of their own", async () => {
    const connection = { resolved: () => ({ indexerUrl: null, backendUrl: null, archiveUrl: null, rpcUrls: {} }) };
    const configuration = { ...live.configuration, indexerUrl: "https://cfg-indexer.test", backendUrl: "https://cfg-prover.test", archiveUrl: "https://cfg-archive.test", rpcUrls: { [pair.second.chainId]: "https://cfg-rpc2.test" } };
    render({ configuration, connection });
    for (const host of ["cfg-indexer.test", "cfg-prover.test", "cfg-archive.test", "cfg-rpc2.test"]) expect(await screen.findByText(host)).toBeInTheDocument();
  });
});

describe("the shortcut menu of the search band", () => {
  it("opens on Down once Escape closed it, ignores other keys while closed, and runs the chosen shortcut", async () => {
    render();
    const input = await screen.findByRole("combobox", { name: "Search Explore" });
    await userEvent.click(input);
    expect(await screen.findByRole("listbox", { name: "Shortcuts" })).toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.keyDown(input, { key: "Tab" });
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    const menu = screen.getByRole("listbox", { name: "Shortcuts" });
    fireEvent.keyDown(input, { key: "End" });
    const options = screen.getAllByRole("option");
    expect(options.at(-1)).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input, { key: "x" });
    expect(menu).toBeInTheDocument();
    window.location.hash = "";
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    expect(window.location.hash).toMatch(/^#\/explore/);
  });
});
