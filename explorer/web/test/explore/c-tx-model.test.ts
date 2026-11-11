import { encodeEventTopics, encodeFunctionData, formatTransaction, formatTransactionReceipt, getAddress, type Abi, type Hex } from "viem";
import { beaconForkGateAbi } from "@zk-bridge/shared";
import { describe, expect, it } from "vitest";
import type { FeedItem, PairConfig } from "@terminal/model/types";
import { FIXTURE_PAIR } from "@terminal/data/fixtures";
import { parseProofs } from "../../src/explore/explore-source";
import { argText, decodeCall, deploymentCallOf, describeTransaction, shortChain, whereItSits } from "../../src/explore/tx-model";
import { RECORDED_HEAD_UPDATES } from "./recorded";
import { RECORDED_RECEIPT, RECORDED_TX } from "./recorded-tx";

const pair: PairConfig = {
  ...FIXTURE_PAIR,
  first: { ...FIXTURE_PAIR.first, chainId: 11155111, name: "Sepolia", contracts: { ...FIXTURE_PAIR.first.contracts, lightClient: getAddress("0x64ddc23ff43ea0cd2ce9a13ef6681ee651e76e4e") } },
  second: { ...FIXTURE_PAIR.second, chainId: 943, name: "PulseChain testnet v4" },
};
const tx = formatTransaction(RECORDED_TX as never);
const receipt = formatTransactionReceipt(RECORDED_RECEIPT as never);
const proofs = parseProofs(RECORDED_HEAD_UPDATES);
const hash = (byte: string): Hex => `0x${byte.repeat(32)}`;
const transfer = (over: Partial<FeedItem>): FeedItem => ({
  id: hash("aa"),
  kind: "token",
  direction: "first-to-second",
  status: "covered",
  sender: getAddress("0x0000000000000000000000000000000000000001"),
  recipient: getAddress("0x0000000000000000000000000000000000000002"),
  token: null,
  amount: null,
  sentAt: 10,
  deliveredAt: null,
  sourceTransactionHash: hash("bb"),
  destinationTransactionHash: null,
  ...over,
});

describe("event arguments as text", () => {
  it("writes bigints in full, lists and structs with their bigints, and anything else as it is", () => {
    expect(argText(12n)).toBe("12");
    expect(argText([1n, [2n, "x"]])).toBe("[1, [2, x]]");
    expect(argText({ a: 3n, b: "y" })).toBe('{"a":"3","b":"y"}');
    expect(argText(null)).toBe("null");
    expect(argText(true)).toBe("true");
  });

  it("writes a short chain name without its network suffix", () => {
    expect(shortChain("PulseChain testnet v4")).toBe("PulseChain");
    expect(shortChain("Sepolia")).toBe("Sepolia");
  });
});

describe("a call's signature", () => {
  const abi: Abi = [{ type: "function", name: "f", stateMutability: "nonpayable", inputs: [{ type: "uint256", name: "" }, { type: "address", name: "to" }], outputs: [] }];

  it("leaves out the name of an unnamed parameter and names the others", () => {
    const data = encodeFunctionData({ abi, functionName: "f", args: [1n, getAddress("0x0000000000000000000000000000000000000001")] });
    expect(decodeCall(data, [abi])).toBe("f(uint256, address to)");
  });

  it("gives null for a call no listed ABI decodes", () => {
    expect(decodeCall("0xdeadbeef", [abi])).toBeNull();
    expect(deploymentCallOf("0xdeadbeef")).toBeNull();
    expect(deploymentCallOf(tx.input)).toMatch(/^update\(/);
  });
});

describe("a transaction that is not a light-client update", () => {
  it("on the second chain, a creation: no recipient, no call, no events that decode, and the kind says so", () => {
    const created = { ...tx, to: null, input: "0x" as Hex };
    const unknownLog = { ...receipt.logs[0]!, topics: [hash("12")] as [Hex] };
    const described = describeTransaction({ chainId: 943, tx: created, receipt: { ...receipt, contractAddress: getAddress("0x0000000000000000000000000000000000000abc"), logs: [unknownLog] }, pair, proofs: [], feed: [] });
    expect(described).toMatchObject({ kind: "Contract creation", to: null, toName: null, functionSignature: null, inputBytes: 0, events: [], proof: null, transfer: null });
  });

  it("to a contract that is not the deployment's: a plain transaction, its call left undecoded", () => {
    const other = { ...tx, to: getAddress("0x00000000000000000000000000000000000000aa"), input: "0xdeadbeef" as Hex };
    const described = describeTransaction({ chainId: 11155111, tx: other, receipt: { ...receipt, contractAddress: null }, pair, proofs: [], feed: [] });
    expect(described).toMatchObject({ kind: "Transaction", toName: null, functionSignature: null, inputBytes: 4 });
  });

  it("an event with no arguments decodes to an empty list", () => {
    const [topic] = encodeEventTopics({ abi: beaconForkGateAbi, eventName: "BeaconRootsDetected" });
    const log = { ...receipt.logs[0]!, topics: [topic] as [Hex], data: "0x" as Hex };
    const described = describeTransaction({ chainId: 11155111, tx, receipt: { ...receipt, logs: [log] }, pair, proofs: [], feed: [] });
    expect(described.events).toMatchObject([{ name: "BeaconRootsDetected", args: [] }]);
  });

  it("a transfer's sending transaction is a send, found by its source hash", () => {
    const sending = transfer({ sourceTransactionHash: tx.hash.toLowerCase() as Hex });
    expect(describeTransaction({ chainId: 11155111, tx, receipt, pair, proofs: [], feed: [sending] }).kind).toBe("Transfer sent");
  });

  it("a transfer's delivering transaction is a delivery, found by its destination hash", () => {
    const delivered = transfer({ destinationTransactionHash: tx.hash.toLowerCase() as Hex, deliveredAt: 99 });
    const described = describeTransaction({ chainId: 11155111, tx, receipt, pair, proofs: [], feed: [delivered] });
    expect(described).toMatchObject({ kind: "Transfer delivered", transfer: delivered });
  });
});

describe("where it sits, from either chain", () => {
  const described = (over: Partial<Parameters<typeof describeTransaction>[0]> = {}) => describeTransaction({ chainId: 943, tx, receipt, pair, proofs: [], feed: [], ...over });

  it("a transaction with no proof and no transfer is one step", () => {
    const steps = whereItSits(described(), pair, null);
    expect(steps).toMatchObject([{ label: "This transaction on PulseChain", done: true, at: null }]);
  });

  it("a transfer with no token: the sending, this transaction, and the delivery with its page and time", () => {
    const sent = transfer({ direction: "second-to-first", sourceTransactionHash: hash("bb"), destinationTransactionHash: hash("cc"), deliveredAt: 50 });
    const steps = whereItSits(described(), pair, sent);
    expect(steps.map((step) => step.label)).toEqual(["Transfer sent", "This transaction on PulseChain", "Delivered on Sepolia"]);
    expect(steps[2]).toMatchObject({ done: true, at: 50, href: `#/explore/tx/11155111/${hash("cc")}`, detail: { kind: "tx", chainId: 11155111, hash: hash("cc") } });
  });

  it("the sending transaction itself is not listed twice, and a proof placed on the second chain names the first as the other side", () => {
    const sending = transfer({ sourceTransactionHash: tx.hash.toLowerCase() as Hex });
    const sentSteps = whereItSits(described({ chainId: 11155111 }), pair, sending);
    expect(sentSteps.map((step) => step.label)).toEqual(["Transfer sent", "Delivered on PulseChain"]);
    const proofOnSecond = parseProofs({ items: [{ ...RECORDED_HEAD_UPDATES.items[0]!, chainId: 943 }] });
    const steps = whereItSits(described({ proofs: proofOnSecond, tx: { ...tx, hash: proofOnSecond[0]!.transactionHash } }), pair, null);
    expect(steps.map((step) => step.label)).toEqual(["Block final on Sepolia", "Proof generated", "This transaction on PulseChain"]);
  });
});
