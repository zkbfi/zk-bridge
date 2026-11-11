import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { formatTransaction, formatTransactionReceipt, getAddress, type Address, type Hex } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FeedItem, PairConfig } from "@terminal/model/types";
import { FIXTURE_PAIR } from "@terminal/data/fixtures";
import { parseProofs } from "../../src/explore/explore-source";
import { createFixtureExploreSource } from "../../src/explore/explore-fixture";
import { AddressPage, BlockDrawer, TransactionPage, TxDrawer } from "../../src/explore/TxAddressPages";
import { buildTestServices } from "../render";
import { connectedWallet, renderWithWallet } from "../app/support";
import { RECORDED_HEAD_UPDATES } from "./recorded";
import { RECORDED_RECEIPT, RECORDED_TX } from "./recorded-tx";

// What the chains answer: each test sets it. `null` for a chain is a chain with no reader.
const chain = vi.hoisted(() => ({ reader: null as null | Record<string, (...args: never[]) => Promise<unknown>>, perChain: null as null | Record<number, unknown> }));
vi.mock("../../src/explore/chain-reader", async (original) => {
  const actual = await original<typeof import("../../src/explore/chain-reader")>();
  return { ...actual, useChainReader: () => (chainId: number) => (chain.perChain !== null ? ((chain.perChain[chainId] ?? null) as never) : chain.reader) };
});

const pair: PairConfig = FIXTURE_PAIR;
const TX = RECORDED_TX.hash as Hex;
const tx = formatTransaction(RECORDED_TX as never);
const receipt = formatTransactionReceipt(RECORDED_RECEIPT as never);
const base = buildTestServices();
const proofOnFirst = parseProofs({ items: [{ ...RECORDED_HEAD_UPDATES.items[0]!, chainId: pair.first.chainId }] });

const show = (ui: React.ReactElement, services: Record<string, unknown> = {}) => renderWithWallet(ui, { wallet: connectedWallet(), services: { pair, ...services } as never });
const hash = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;

beforeEach(() => {
  window.localStorage.clear();
  chain.reader = null;
  chain.perChain = null;
});

describe("a step's drawers", () => {
  it("a block drawer reads the block from the chain when the proof does not carry its hash, and says what is not known", async () => {
    chain.reader = { block: async () => ({ number: 5n, hash: hash(9), timestamp: 1793300049n }) };
    show(<BlockDrawer detail={{ kind: "block", chainId: pair.first.chainId, number: 5n, hash: null, slot: null, period: null }} />);
    await waitFor(() => expect(screen.getByText("0x00000000…0009")).toBeInTheDocument());
    expect(screen.getAllByTitle("Not known")).toHaveLength(2);
    expect(screen.getByRole("link", { name: "5" })).toHaveAttribute("href", `#/explore/block/${pair.first.chainId}/5`);
    expect(screen.getByRole("link", { name: "The block on the chain's explorer" })).toBeInTheDocument();
  });

  it("a block drawer shows the hash it was given, the slot and the committee, and a dash for what the chain cannot give", () => {
    chain.reader = null;
    show(<BlockDrawer detail={{ kind: "block", chainId: 999, number: 7n, hash: hash(3), slot: 100n, period: 2n }} />);
    expect(screen.getByText("0x00000000…0003")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "100" })).toHaveAttribute("href", "#/explore/slot/100");
    expect(screen.getByText(/period 2/)).toBeInTheDocument();
    expect(screen.getByTitle("Read from the chain")).toBeInTheDocument();
    expect(screen.getByTitle("No explorer for this chain")).toBeInTheDocument();
  });

  it("a block drawer whose chain read has no hash says so", async () => {
    chain.reader = { block: async () => ({ number: 5n, hash: null, timestamp: 1793300049n }) };
    show(<BlockDrawer detail={{ kind: "block", chainId: pair.first.chainId, number: 5n, hash: null, slot: null, period: null }} />);
    await screen.findByText(/^\d\d\/\d\d\/2026/);
    expect(screen.getAllByTitle("Read from the chain")).toHaveLength(1);
  });

  it("a transaction drawer shows its cost when it has one, and the explorer link when the chain has one", () => {
    const { unmount } = show(<TxDrawer detail={{ kind: "tx", chainId: pair.first.chainId, hash: hash(1) }} cost={<span>0.1 ETH</span>} />);
    expect(screen.getByText("0.1 ETH")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "The transaction on the chain's explorer" })).toBeInTheDocument();
    unmount();
    show(<TxDrawer detail={{ kind: "tx", chainId: 999, hash: hash(1) }} />);
    expect(screen.queryByText("Cost")).toBeNull();
    expect(screen.getByTitle("No explorer for this chain")).toBeInTheDocument();
  });
});

describe("the transaction page", () => {
  it("says only the hash while the chain has no reader", () => {
    chain.perChain = {};
    show(<TransactionPage chainId={pair.first.chainId} hash={TX} />);
    expect(screen.getByText("Transaction", { selector: ".zb-xband-big" })).toBeInTheDocument();
    expect(screen.getByText(TX)).toBeInTheDocument();
  });

  it("says Reading while the chain answers, and that the chain has no such transaction when it does not", async () => {
    let fail!: (error: Error) => void;
    chain.reader = { transaction: () => new Promise((_, reject) => (fail = reject)) };
    show(<TransactionPage chainId={pair.first.chainId} hash={TX} />);
    expect(await screen.findByText("Reading…")).toBeInTheDocument();
    fail(new Error("not found"));
    expect(await screen.findByText("Not found")).toBeInTheDocument();
    expect(screen.getByText(`${pair.first.name} has no transaction with this hash.`)).toBeInTheDocument();
  });

  it("shows a reverted creation: no recipient, no call, no events, and opens the raw input", async () => {
    const created = { ...tx, to: null, input: "0x" as Hex };
    chain.reader = { transaction: async () => ({ tx: created, receipt: { ...receipt, status: "reverted", logs: [], contractAddress: getAddress("0x0000000000000000000000000000000000000abc") } }) };
    show(<TransactionPage chainId={999} hash={TX} />, { pair: { ...pair, first: { ...pair.first, chainId: 999 } } });
    expect(await screen.findByText("Contract creation")).toBeInTheDocument();
    expect(screen.getByText("reverted")).toBeInTheDocument();
    expect(screen.getByText("contract creation")).toBeInTheDocument();
    expect(screen.getByText("none (a plain send)")).toBeInTheDocument();
    expect(screen.getByText("No events from the deployment's contracts.")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "On the chain's explorer" })).toBeNull();
    const raw = screen.getByRole("button", { name: /Input data \(0 bytes\)/ });
    await userEvent.click(raw);
    expect(raw).toHaveAttribute("aria-expanded", "true");
    expect(document.querySelector("pre")).toHaveTextContent("0x");
    await userEvent.click(raw);
    expect(document.querySelector("pre")).toBeNull();
  });

  it("names a call to an account by its address and an unknown call as not in the ABIs", async () => {
    const other = getAddress("0x00000000000000000000000000000000000000aa");
    chain.reader = { transaction: async () => ({ tx: { ...tx, to: other, input: "0xdeadbeef" as Hex }, receipt: { ...receipt, logs: [] } }) };
    show(<TransactionPage chainId={pair.first.chainId} hash={TX} />);
    expect(await screen.findByText("not in the deployment's ABIs")).toBeInTheDocument();
    expect(screen.getByText("Transaction", { selector: ".zb-xband-big" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /0x00000000…00aa/i })).toHaveAttribute("href", `#/explore/address/${other}`);
  });

  it("names a call to the deployment's own contract and links to its contract page, on the second chain", async () => {
    const lightClient = pair.second.contracts.lightClient!;
    chain.reader = { transaction: async () => ({ tx: { ...tx, to: lightClient }, receipt: { ...receipt, logs: [] } }) };
    show(<TransactionPage chainId={pair.second.chainId} hash={TX} />);
    const link = await screen.findByRole("link", { name: /Light client/ });
    expect(link).toHaveAttribute("href", `#/explore/contract/${pair.second.chainId}/${lightClient}`);
    expect(screen.getByText(new RegExp(`^${pair.second.name} · block`))).toBeInTheDocument();
  });

  it("links a light-client update to its proof and shows each step with its time or waiting", async () => {
    chain.reader = { transaction: async () => ({ tx, receipt }), block: async () => ({ number: 1n, hash: hash(2), timestamp: 1793300049n }) };
    const transfer: FeedItem = {
      id: hash(7), kind: "token", direction: "first-to-second", status: "covered",
      sender: getAddress("0x0000000000000000000000000000000000000001"), recipient: getAddress("0x0000000000000000000000000000000000000002"),
      token: null, amount: null, sentAt: 1793299000, deliveredAt: null, sourceTransactionHash: TX, destinationTransactionHash: null,
    };
    const dataSource = { ...base.dataSource, getFeed: async () => ({ items: [transfer], hasMore: false }) };
    show(<TransactionPage chainId={pair.first.chainId} hash={TX} />, { explore: { ...createFixtureExploreSource(), proofs: async () => proofOnFirst, findProofs: async () => [] }, dataSource });
    expect(await screen.findByRole("link", { name: "Proof #1" })).toHaveAttribute("href", `#/explore/proof/${pair.first.chainId}/1`);
    expect(screen.getByText("Block final on PulseChain")).toBeInTheDocument();
    expect(screen.getByText("Delivered on PulseChain")).toBeInTheDocument();
    expect(screen.getByText("waiting")).toBeInTheDocument();
  });
});

describe("the address page", () => {
  const address = getAddress("0x00000000000000000000000000000000000000aa");
  const item = (n: number, over: Partial<FeedItem>): FeedItem => ({
    id: hash(n), kind: "token", direction: "first-to-second", status: "covered", sender: address, recipient: getAddress("0x0000000000000000000000000000000000000002"),
    token: { address: getAddress("0x0000000000000000000000000000000000001001"), symbol: "USDC", decimals: 6, side: "first", counterpart: null },
    amount: 5_000_000n, sentAt: 1_790_000_000, deliveredAt: null, sourceTransactionHash: hash(100 + n), destinationTransactionHash: null, ...over,
  });

  it("with no reader for a chain shows dashes for it, names no role, and lists the transfers and a message without a token", async () => {
    chain.perChain = { [pair.first.chainId]: { account: async () => ({ balance: 2_000_000_000_000_000_000n, nonce: 1, isContract: true }) } };
    const dataSource = { ...base.dataSource, getFeed: async () => ({ items: [item(1, {}), item(2, { token: null, amount: null }), item(3, { sender: getAddress("0x0000000000000000000000000000000000000003"), recipient: address })], hasMore: false }) };
    show(<AddressPage address={address} />, { dataSource, explore: { ...createFixtureExploreSource(), proofs: async () => [] } });
    expect(await screen.findByText("contract")).toBeInTheDocument();
    expect(screen.getByText("1 transactions sent")).toBeInTheDocument();
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("2 · 1 transfers")).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: /5 USDC/ })).toHaveLength(2);
    expect(screen.getByRole("link", { name: /Message 0x00000000…0002/ })).toBeInTheDocument();
  });

  it("opens on the proofs when the address only posted proofs, switches back to the transfers, and says when it has none", async () => {
    chain.reader = { account: async () => ({ balance: 0n, nonce: 0, isContract: false }) };
    const poster = getAddress(RECORDED_HEAD_UPDATES.items[0]!.poster);
    const secondChainProof = parseProofs({ items: [{ ...RECORDED_HEAD_UPDATES.items[0]!, chainId: pair.second.chainId }] });
    const dataSource = { ...base.dataSource, getFeed: async () => ({ items: [], hasMore: false }) };
    // The proofs arrive after the first render, so the tab starts on the transfers; the person opens the proofs.
    show(<AddressPage address={poster} />, { dataSource, explore: { ...createFixtureExploreSource(), proofs: async () => [...secondChainProof, ...proofOnFirst] } });
    expect(await screen.findByText("proof poster")).toBeInTheDocument();
    expect(screen.getByText("No transfers.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: /Proofs/ }));
    expect(screen.getAllByRole("link", { name: /Proof #1/ })).toHaveLength(2);
    await userEvent.click(screen.getByRole("tab", { name: /Transfers/ }));
    expect(screen.getByText("No transfers.")).toBeInTheDocument();
  });

  it("shows no explorer link for a chain without one", async () => {
    chain.reader = { account: async () => ({ balance: 0n, nonce: 0, isContract: false }) };
    show(<AddressPage address={address} />, { pair: { ...pair, first: { ...pair.first, chainId: 999 } }, explore: { ...createFixtureExploreSource(), proofs: async () => [] } });
    await screen.findByText("account");
    expect(screen.getAllByRole("link", { name: /explorer$/ })).toHaveLength(1);
  });

  it("names a deployment contract's role from the pair", async () => {
    chain.reader = { account: async () => ({ balance: 0n, nonce: 0, isContract: true }) };
    const tokenMediator = pair.first.contracts.tokenMediator!;
    show(<AddressPage address={tokenMediator} />, { explore: { ...createFixtureExploreSource(), proofs: async () => [] } });
    expect(await screen.findByText("tokenMediator")).toBeInTheDocument();
    expect(await screen.findByText("contract")).toBeInTheDocument();
  });
});
