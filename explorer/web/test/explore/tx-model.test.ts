import { formatTransaction, formatTransactionReceipt, getAddress } from "viem";
import { describe, expect, it } from "vitest";
import type { FeedItem, PairConfig } from "@terminal/model/types";
import { FIXTURE_PAIR } from "@terminal/data/fixtures";
import { parseProofs } from "../../src/explore/explore-source";
import { describeTransaction, whereItSits } from "../../src/explore/tx-model";
import { RECORDED_HEAD_UPDATES } from "./recorded";
import { RECORDED_RECEIPT, RECORDED_TX } from "./recorded-tx";

// The live pair: Sepolia (first) ↔ PulseChain testnet v4 (second), with the light client on Sepolia that was updated.
const pair: PairConfig = {
  ...FIXTURE_PAIR,
  first: { ...FIXTURE_PAIR.first, chainId: 11155111, name: "Sepolia", contracts: { ...FIXTURE_PAIR.first.contracts, lightClient: getAddress("0x64ddc23ff43ea0cd2ce9a13ef6681ee651e76e4e") } },
  second: { ...FIXTURE_PAIR.second, chainId: 943, name: "PulseChain testnet v4" },
};
const tx = formatTransaction(RECORDED_TX as never);
const receipt = formatTransactionReceipt(RECORDED_RECEIPT as never);
const proofs = parseProofs(RECORDED_HEAD_UPDATES);

describe("a transaction, decoded (recorded: the first light-client update on Sepolia)", () => {
  it("names its kind and contract, decodes the call from the ABI, and gives gas, fee, nonce and position", () => {
    const described = describeTransaction({ chainId: 11155111, tx, receipt, pair, proofs, feed: [] });
    expect(described).toMatchObject({
      kind: "Light-client update",
      success: true,
      blockNumber: 12021502n,
      from: getAddress("0xf71cbaa5a165fad2ffff6b0d68e84d67b1f75eac"),
      to: getAddress("0x64ddc23ff43ea0cd2ce9a13ef6681ee651e76e4e"),
      toName: "Light client",
      gasUsed: 604091n,
      gasPriceWei: 100000000n,
      feeWei: 60409100000000n,
      nonce: 7,
      index: 59,
    });
    expect(described.functionSignature).toMatch(/^update\(bytes \w+, bytes \w+\)$/);
    expect(described.proof?.number).toBe(1);
  });

  it("decodes its events by name from the ABIs", () => {
    const described = describeTransaction({ chainId: 11155111, tx, receipt, pair, proofs, feed: [] });
    expect(described.events).toHaveLength(1);
    expect(described.events[0]!.name).toBe("HeadUpdated");
    expect(described.events[0]!.args.map(([name]) => name)).toContain("slot");
    expect(Object.fromEntries(described.events[0]!.args)["slot"]).toBe("11194368");
  });
});

describe("where it sits", () => {
  it("for a proof with no transfer yet: the block final on the tracked chain, the proof, this transaction", () => {
    const described = describeTransaction({ chainId: 11155111, tx, receipt, pair, proofs, feed: [] });
    const steps = whereItSits(described, pair, null);
    expect(steps.map((step) => step.label)).toEqual(["Block final on PulseChain", "Proof generated", "This transaction on Sepolia"]);
    expect(steps[0]!.detail).toEqual({ kind: "block", chainId: 943, number: 25767883n, hash: "0x9ddeae6daafa2e91d57c8efa240583ff83c1f95a2e20cce68a6564e56303ac43", slot: 11194368n, period: 1366n });
    expect(steps.every((step) => step.done)).toBe(true);
    expect(steps[2]!.at).toBe(1793300844);
  });

  it("starts with the user's action when a transfer is part of it, and ends with its delivery", () => {
    const transfer: FeedItem = {
      id: `0x${"aa".repeat(32)}`,
      kind: "token",
      direction: "second-to-first",
      status: "covered",
      sender: getAddress("0x0000000000000000000000000000000000000001"),
      recipient: getAddress("0x0000000000000000000000000000000000000002"),
      token: { address: getAddress("0x0000000000000000000000000000000000001001"), symbol: "USDC", decimals: 6, side: "second", counterpart: null },
      amount: 80_000_000n,
      sentAt: 1793299000,
      deliveredAt: null,
      sourceTransactionHash: `0x${"bb".repeat(32)}`,
      destinationTransactionHash: null,
    };
    const described = describeTransaction({ chainId: 11155111, tx, receipt, pair, proofs, feed: [transfer] });
    const steps = whereItSits(described, pair, transfer);
    expect(steps[0]).toMatchObject({ label: "Transfer sent · 80 USDC", done: true, at: 1793299000, href: `#/explore/tx/943/0x${"bb".repeat(32)}` });
    expect(steps.at(-1)).toMatchObject({ label: "Delivered on Sepolia", done: false });
  });
});
