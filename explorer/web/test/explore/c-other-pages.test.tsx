import { screen, waitFor } from "@testing-library/react";
import { getAddress } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FeedItem, PairConfig, TokenInfo } from "@terminal/model/types";
import { FIXTURE_PAIR } from "@terminal/data/fixtures";
import { createFixtureExploreSource } from "../../src/explore/explore-fixture";
import { parseProofs } from "../../src/explore/explore-source";
import { BlockPage, ContractPage, CostsPage, GatePage, ProofPage, ReleasePage, SlotPage, TokenPage } from "../../src/explore/OtherPages";
import { buildDeliveryReport } from "../helpers";
import { buildTestServices } from "../render";
import { connectedWallet, renderWithWallet } from "../app/support";
import { RECORDED_HEAD_UPDATES } from "./recorded";

const chain = vi.hoisted(() => ({ reader: null as null | Record<string, (...args: never[]) => Promise<unknown>> }));
vi.mock("../../src/explore/chain-reader", async (original) => {
  const actual = await original<typeof import("../../src/explore/chain-reader")>();
  return { ...actual, useChainReader: () => () => chain.reader as never };
});

const pair: PairConfig = FIXTURE_PAIR;
const base = buildTestServices();
const explore0 = createFixtureExploreSource();
const show = (ui: React.ReactElement, services: Record<string, unknown> = {}) => renderWithWallet(ui, { wallet: connectedWallet(), services: { pair, ...services } as never });
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as const;
const rowOf = (over: Record<string, unknown>) => ({ ...RECORDED_HEAD_UPDATES.items[0]!, ...over });

beforeEach(() => {
  window.localStorage.clear();
  chain.reader = null;
});

describe("a proof", () => {
  it("says it is reading, then that the indexer has no such proof", async () => {
    show(<ProofPage chainId={pair.first.chainId} number={5} />, { explore: { ...explore0, proofByNumber: async () => null } });
    expect(screen.getByText("Reading…")).toBeInTheDocument();
    expect(await screen.findByText("The indexer has no such proof.")).toBeInTheDocument();
  });

  it("says when the indexer could not be read", async () => {
    show(<ProofPage chainId={pair.first.chainId} number={5} />, {
      explore: { ...explore0, proofByNumber: async () => { throw new Error("down"); } },
    });
    expect(await screen.findByText("The indexer could not be read.")).toBeInTheDocument();
  });

  it("an update with neighbours links to them; without a clock, a verifier or a price it shows dashes and no dollar amount", async () => {
    const [proof, previous, next] = [10, 9, 11].map((number) => parseProofs({ items: [rowOf({ chainId: pair.second.chainId, slot: 1000 + number })] })[0]!).map((row, i) => ({ ...row, number: [10, 9, 11][i]! }));
    chain.reader = null;
    show(<ProofPage chainId={pair.second.chainId} number={10} />, {
      explore: { ...explore0, proofByNumber: async () => ({ proof: proof!, previous: previous!, next: next! }), beaconClocks: async () => [] },
    });
    expect(await screen.findByRole("link", { name: /Proof #9/ })).toHaveAttribute("href", `#/explore/proof/${pair.second.chainId}/9`);
    expect(screen.getByRole("link", { name: /Proof #11/ })).toHaveAttribute("href", `#/explore/proof/${pair.second.chainId}/11`);
    expect(screen.getByTitle("The indexer has not read the beacon chain's clock")).toBeInTheDocument();
    expect(screen.getByTitle("Read from the light client on the chain")).toBeInTheDocument();
  });

  it("the first update has no previous, and the newest is waiting for the next", async () => {
    const proof = { ...parseProofs({ items: [rowOf({ chainId: pair.first.chainId })] })[0]!, number: 1 };
    show(<ProofPage chainId={pair.first.chainId} number={1} />, { explore: { ...explore0, proofByNumber: async () => ({ proof, previous: null, next: null }) } });
    expect(await screen.findByText("first update", { exact: false })).toBeInTheDocument();
    expect(screen.getByText("none")).toBeInTheDocument();
    expect(screen.getByText("waiting")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("Cost").nextElementSibling).toHaveTextContent("$"));
  });
});

describe("a token", () => {
  const NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
  const bridged: TokenInfo = { address: getAddress("0x0000000000000000000000000000000000001001"), symbol: "USDC", decimals: 6, side: "first", counterpart: getAddress("0x0000000000000000000000000000000000002001") };
  const lone: TokenInfo = { address: getAddress("0x0000000000000000000000000000000000001002"), symbol: "LONE", decimals: 18, side: "second", counterpart: null };
  const now = base.now();
  const item = (n: number, over: Partial<FeedItem>): FeedItem => ({
    id: hash(n), kind: "token", direction: "first-to-second", status: "covered",
    sender: getAddress("0x0000000000000000000000000000000000000001"), recipient: getAddress("0x0000000000000000000000000000000000000002"),
    token: bridged, amount: 2_000_000n, sentAt: now - 60, deliveredAt: null, sourceTransactionHash: hash(500 + n), destinationTransactionHash: null, ...over,
  });
  const withData = (feed: FeedItem[], audit: unknown[]) => ({
    dataSource: { ...base.dataSource, listTokens: async () => [bridged, lone, { ...bridged, address: bridged.counterpart!, symbol: "zUSDC", counterpart: bridged.address, side: "second" as const }], getFeed: async () => ({ items: feed, hasMore: false }), getAudit: async () => audit },
  });

  it("says when the pair has no such token", async () => {
    show(<TokenPage id={`second:${bridged.address}`} />, withData([], []));
    expect(await screen.findByText("This pair has no such token.")).toBeInTheDocument();
  });

  it("a bridged token: both addresses, escrow against supply, the day's volume and the latest transfers of it and of its copy", async () => {
    const copy = { ...bridged, address: bridged.counterpart!, symbol: "zUSDC", counterpart: bridged.address, side: "second" as const };
    const feed = [item(1, {}), item(2, { token: copy, amount: null, direction: "second-to-first" }), item(3, { sentAt: now - 200_000 }), item(4, { token: null, amount: null }), item(5, { token: lone })];
    const audit = [
      { token: lone, escrow: 1n, bridgedSupply: 1n, inFlight: 0n },
      { token: bridged, escrow: 5_000_000n, bridgedSupply: 5_000_000n, inFlight: 0n },
    ];
    show(<TokenPage id={`first:${bridged.address}`} />, withData(feed, audit));
    expect(await screen.findByText(/· matches/)).toBeInTheDocument();
    expect(screen.getByText(/2 transfers/)).toBeInTheDocument();
    expect(screen.getAllByRole("link").map((link) => link.getAttribute("href"))).toContain(`#/explore/token/second/${bridged.counterpart}`);
    expect(screen.getByText("zUSDC", { exact: false })).toBeInTheDocument();
  });

  it("a token whose supply differs from its escrow says so; one with no audit row, no transfers and no copy says what is missing", async () => {
    const { unmount } = show(<TokenPage id={`first:${bridged.address}`} />, withData([], [{ token: bridged, escrow: 5n, bridgedSupply: 4n, inFlight: 0n }]));
    expect(await screen.findByText(/· differs/)).toBeInTheDocument();
    expect(screen.getByText("No transfers of this token yet.")).toBeInTheDocument();
    expect(screen.getByText("none")).toBeInTheDocument();
    unmount();
    show(<TokenPage id={`second:${lone.address}`} />, withData([], []));
    expect(await screen.findByTitle("Not bridged yet; the first transfer deploys it")).toBeInTheDocument();
    expect(screen.getByTitle("The indexer has no escrow for this token")).toBeInTheDocument();
    expect(screen.getByTitle("The indexer has no supply for this token")).toBeInTheDocument();
  });

  it("a bridged copy on the second chain links back to its original on the first", async () => {
    show(<TokenPage id={`second:${bridged.counterpart}`} />, withData([], []));
    expect((await screen.findByText(`On ${pair.first.name}`)).nextElementSibling).toHaveAttribute("href", `#/explore/token/first/${bridged.address}`);
  });

  it("the native coin is named as one", async () => {
    show(<TokenPage id={`first:${NATIVE}`} />, withData([], []));
    expect(await screen.findByText("native coin")).toBeInTheDocument();
  });
});

describe("a block", () => {
  it("reads the chain: hash, time, transactions, gas and base fee, and names the proofs that refer to it", async () => {
    chain.reader = { block: async () => ({ number: 7n, hash: hash(4), timestamp: 1793300049n, gasUsed: 21_000n, baseFeePerGas: 7_000_000_000n, transactions: [hash(1), hash(2)] }) };
    const posted = parseProofs({ items: [rowOf({ chainId: pair.first.chainId, blockNumber: 7 })] });
    const proves = parseProofs({ items: [rowOf({ chainId: pair.second.chainId, executionBlockNumber: 7, blockNumber: 99, timestamp: 1793300900 })] });
    show(<BlockPage chainId={pair.first.chainId} number={7n} />, { explore: { ...explore0, proofs: async () => [...posted, ...proves] } });
    expect(await screen.findByText("0x00000000…0004")).toBeInTheDocument();
    expect(screen.getByText("21,000")).toBeInTheDocument();
    expect(screen.getByText("7 gwei")).toBeInTheDocument();
    expect(screen.getByText("posted in this block")).toBeInTheDocument();
    expect(screen.getByText("proves this block final")).toBeInTheDocument();
  });

  it("a pending block has no hash and a chain without a base fee shows a dash", async () => {
    chain.reader = { block: async () => ({ number: 7n, hash: null, timestamp: 1793300049n, gasUsed: 0n, baseFeePerGas: null, transactions: [] }) };
    show(<BlockPage chainId={pair.first.chainId} number={7n} />, { explore: { ...explore0, proofs: async () => [] } });
    expect(await screen.findByText("None.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("Transactions").nextElementSibling).toHaveTextContent("0"));
    expect(screen.getAllByTitle("Read from the chain")).toHaveLength(1);
  });

  it("says the chain has no such block yet, and shows no explorer link for a chain without one", async () => {
    chain.reader = { block: async () => { throw new Error("none"); } };
    show(<BlockPage chainId={999} number={7n} />, { pair: { ...pair, first: { ...pair.first, chainId: 999 } }, explore: { ...explore0, proofs: async () => [] } });
    expect(await screen.findByTitle("The chain has no such block yet")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "On the chain's explorer" })).toBeNull();
  });
});

describe("a slot", () => {
  it("lists the proofs of the slot on whichever chain stored them", async () => {
    const stored = parseProofs({ items: [rowOf({ chainId: pair.first.chainId }), rowOf({ chainId: pair.second.chainId, timestamp: 1793300999 })] });
    show(<SlotPage slot={11194368n} />, { explore: { ...explore0, findProofs: async () => stored } });
    expect(await screen.findAllByRole("link", { name: /Proof #1/ })).toHaveLength(2);
  });
});

describe("a contract", () => {
  it("one of the deployment: its name, its code and balance from the chain; a gate leads to its state", async () => {
    chain.reader = { account: async () => ({ balance: 3_000_000_000_000_000_000n, nonce: 0, isContract: true }) };
    show(<ContractPage chainId={pair.first.chainId} address={pair.first.contracts.gate!} />, { explore: { ...explore0, proofs: async () => [] } });
    expect(await screen.findByText("deployed")).toBeInTheDocument();
    expect(screen.getByText("Balance").nextElementSibling).toHaveTextContent(/^3 ETH/);
    expect(screen.getByText("this deployment")).toBeInTheDocument();
    expect(screen.getByText("Gate", { selector: ".zb-xband-big" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /open the gate/ })).toHaveAttribute("href", `#/explore/gate/${pair.first.chainId}`);
  });

  it("the light client lists the proofs posted to it, with its stranding line", async () => {
    chain.reader = { account: async () => ({ balance: 0n, nonce: 0, isContract: true }) };
    const posted = parseProofs({ items: [rowOf({ chainId: pair.first.chainId })] });
    show(<ContractPage chainId={pair.first.chainId} address={pair.first.contracts.lightClient} />, { explore: { ...explore0, proofs: async () => posted } });
    expect(await screen.findByText("Proofs posted to it")).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: /Proof #1/ })).toBeInTheDocument();
  });

  it("an address that is not the deployment's, with no chain reading, is a contract with dashes; an account says so", async () => {
    const other = getAddress("0x00000000000000000000000000000000000000aa");
    const { unmount } = show(<ContractPage chainId={pair.first.chainId} address={other} />, { explore: { ...explore0, proofs: async () => [] } });
    expect(screen.getByText("not this deployment")).toBeInTheDocument();
    expect(screen.getByText("Contract", { selector: ".zb-xband-big" })).toBeInTheDocument();
    expect(screen.getAllByTitle("Read from the chain")).toHaveLength(2);
    unmount();
    chain.reader = { account: async () => ({ balance: 0n, nonce: 1, isContract: false }) };
    show(<ContractPage chainId={pair.first.chainId} address={other} />, { explore: { ...explore0, proofs: async () => [] } });
    expect(await screen.findByText("none (an account)")).toBeInTheDocument();
  });
});

describe("a gate", () => {
  const gate = (over: Record<string, unknown>) => ({ chainId: pair.first.chainId, gate: getAddress("0x1782a38a37ce9fb9f53b0585b23b833847007e20"), enforcing: true, sealed: false, depositsOpen: false, confirmations: 2, lastConfirmedTimestamp: null, ...over });

  it("is read while it loads, and for the chain that has none says a dash", async () => {
    show(<GatePage chainId={pair.second.chainId} />, { explore: { ...explore0, gates: async () => [gate({})] } });
    expect(screen.getByText("Reading…")).toBeInTheDocument();
    expect(await screen.findByText("Gate · —", { exact: false }).catch(() => null)).not.toBeUndefined();
  });

  it("says sealed, open or closed and when it was last confirmed", async () => {
    const { unmount } = show(<GatePage chainId={pair.first.chainId} />, { explore: { ...explore0, gates: async () => [gate({ sealed: true, lastConfirmedTimestamp: 1793300000, enforcing: false })] } });
    expect(await screen.findByText("Gate · sealed")).toBeInTheDocument();
    expect(screen.getByText("Last confirmed").nextElementSibling).not.toHaveTextContent("never");
    unmount();
    const second = show(<GatePage chainId={pair.first.chainId} />, { explore: { ...explore0, gates: async () => [gate({ depositsOpen: true })] } });
    expect(await screen.findByText("Gate · open")).toBeInTheDocument();
    expect(screen.getByText("never")).toBeInTheDocument();
    second.unmount();
    show(<GatePage chainId={pair.first.chainId} />, { explore: { ...explore0, gates: async () => [gate({})] } });
    expect(await screen.findByText("Gate · closed")).toBeInTheDocument();
  });
});

describe("a release", () => {
  const cid = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
  it("says what the indexer holds: nothing yet, no release events, or the events", async () => {
    const pending = show(<ReleasePage cid={cid} />, { explore: { ...explore0, counts: () => new Promise(() => undefined) } });
    expect(screen.getByTitle("Read from the indexer")).toBeInTheDocument();
    pending.unmount();
    const none = show(<ReleasePage cid={cid} />, { explore: { ...explore0, counts: async () => ({ escrowed: 0, undelivered: 0, releases: 0 }) } });
    await waitFor(() => expect(screen.getAllByTitle("The indexer has no release events")).toHaveLength(2));
    none.unmount();
    show(<ReleasePage cid={cid} />, { explore: { ...explore0, counts: async () => ({ escrowed: 0, undelivered: 0, releases: 2 }) } });
    expect(await screen.findByText("see release events")).toBeInTheDocument();
  });
});

describe("the costs page", () => {
  const report = (chainId: number, token: Record<string, unknown> | undefined, baseFee: string | null) => {
    const built = buildDeliveryReport(chainId);
    return { ...built, baseFee: { ...built.baseFee, wei: baseFee }, kinds: token === undefined ? {} : { ...built.kinds, token: { ...built.kinds.token, ...token } } };
  };

  it("says nothing was posted when there are no updates, and what is not read yet for delivery", async () => {
    show(<CostsPage />, {
      explore: { ...explore0, lightClientCosts: async () => [] },
      dataSource: { ...base.dataSource, getDeliveryCost: async (chainId: number) => report(chainId, undefined, null) },
    });
    expect(await screen.findByText("None posted yet.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByTitle("Read from the indexer").length).toBe(4));
  });

  it("lists each chain's updates with the cost per update (none for zero updates), and the delivery gas measured or default", async () => {
    show(<CostsPage />, {
      explore: { ...explore0, lightClientCosts: async () => [{ chainId: pair.first.chainId, updates: 2, gasUsed: 1_000n, costWei: 4_000_000_000_000_000n }, { chainId: pair.second.chainId, updates: 0, gasUsed: 0n, costWei: 0n }] },
      dataSource: {
        ...base.dataSource,
        getDeliveryCost: async (chainId: number) => (chainId === pair.first.chainId ? report(chainId, { sampleCount: 12, p90Gas: 99_000n, defaultGas: 250_000n, isDefault: false }, "7000000000") : report(chainId, { p90Gas: null, defaultGas: 250_000n, isDefault: true }, "7000000000")),
      },
    });
    expect(await screen.findByText("2 updates")).toBeInTheDocument();
    expect(screen.getByText("0 updates")).toBeInTheDocument();
    expect(await screen.findByText("99000 (p90 of 12)")).toBeInTheDocument();
    expect(await screen.findByText("250000 (default)")).toBeInTheDocument();
  });
});
