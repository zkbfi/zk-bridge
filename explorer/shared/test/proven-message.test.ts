import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { concat, encodeAbiParameters, encodeFunctionData, keccak256, toRlp, type Hex } from "viem";
import { messageBridgeAbi } from "../src/abis/index.js";
import { describe, expect, it } from "vitest";
import { readProvenMessage, readTrieValue } from "../src/proven-message.js";

// The contract test vectors of the light client. Each carries the calldata of `executeMessage` and, for an accepted
// proof, the message that the contract delivers.
const FIXTURES = join(import.meta.dirname, "../../../light-client/tests/fixtures/message");
type Fixture = {
  name: string;
  calldata: Hex;
  expected: { result: string; message?: Record<string, string | number> };
};
const fixture = (name: string): Fixture => JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8")) as Fixture;
const accepted = readdirSync(FIXTURES)
  .filter((file) => file.includes("_accept_"))
  .map((file) => fixture(file.replace(/\.json$/, "")));

describe("readProvenMessage", () => {
  it.each(accepted.map((entry) => [entry.name, entry] as const))("reads the message that the contract delivers: %s", (_, entry) => {
    const message = entry.expected.message!;
    const proven = readProvenMessage(entry.calldata);
    expect(proven.messageId).toBe(String(message.messageId).toLowerCase());
    expect(proven.sourceTransactionHash).toBe(String(message.sourceTransactionHash).toLowerCase());
    expect(proven.sender.toLowerCase()).toBe(String(message.sender).toLowerCase());
    expect(proven.executor.toLowerCase()).toBe(String(message.executor).toLowerCase());
    expect(proven).not.toHaveProperty("gasLimit");
    expect(proven.sourceChainId).toBe(BigInt(message.sourceChainId!));
    expect(proven.destinationChainId).toBe(BigInt(message.destinationChainId!));
  });

  it.each([
    "electra_reject_corrupted_receipt_proof",
    "electra_reject_corrupted_transaction_proof",
    "electra_reject_wrong_receipt_index",
    "electra_reject_index_mismatch",
    "electra_reject_failed_status_receipt",
    "electra_reject_log_index_out_of_range",
    "electra_reject_wrong_topic",
    "electra_reject_wrong_topic_count",
    "electra_reject_malformed_event_data",
    "electra_reject_message_id_mismatch",
  ])("refuses a proof that the contract refuses for its receipt or log: %s", (name) => {
    expect(() => readProvenMessage(fixture(name).calldata)).toThrow();
  });

  it("leaves the beacon part to the contract: a tampered header with the same roots still names its message", () => {
    // Only the link of the block hash to the beacon block stops this proof, and the contract checks that link.
    expect(readProvenMessage(fixture("electra_reject_tampered_header_rlp").calldata).messageId).toMatch(/^0x/);
  });

  it("refuses calldata that is not executeMessage", () => {
    expect(() => readProvenMessage("0x12345678")).toThrow();
  });
});

describe("readTrieValue", () => {
  // A trie with the one leaf `key -> value` has the leaf as its root.
  const leaf = (path: Hex, value: Hex): Hex => toRlp([path, value]);

  it("reads a leaf at the root", () => {
    const node = leaf("0x2080", `0x${"ab".repeat(40)}`);
    expect(readTrieValue(keccak256(node), "0x80", [node])).toBe(`0x${"ab".repeat(40)}`);
  });

  it("follows a branch to a hashed child and to an inline child", () => {
    const big = leaf("0x30", `0x${"cd".repeat(40)}`); // key 0x80: nibble 8 in the branch, then the odd leaf path 0
    const children: (Hex | Hex[])[] = Array.from({ length: 17 }, () => "0x");
    children[8] = keccak256(big);
    children[0] = ["0x31", "0x01"]; // key 0x01: nibble 0 in the branch, then the inline odd leaf path 1
    const branch = toRlp(children as Hex[]);
    expect(readTrieValue(keccak256(branch), "0x80", [branch, big])).toBe(`0x${"cd".repeat(40)}`);
    expect(readTrieValue(keccak256(branch), "0x01", [branch])).toBe("0x01");
  });

  it("follows an extension, and reads a value kept in a branch", () => {
    const branchChildren: Hex[] = Array.from({ length: 17 }, () => "0x");
    branchChildren[16] = `0x${"ee".repeat(40)}`;
    const branch = toRlp(branchChildren);
    const extension = toRlp(["0x0012", keccak256(branch)]); // even extension with the path 1, 2
    expect(readTrieValue(keccak256(extension), "0x12", [extension, branch])).toBe(`0x${"ee".repeat(40)}`);
    expect(() => readTrieValue(keccak256(extension), "0x13", [extension, branch])).toThrow(/not in the trie/);
  });

  it("refuses a node whose hash differs, a missing node, an absent key and a malformed node", () => {
    const node = leaf("0x2080", `0x${"ab".repeat(40)}`);
    expect(() => readTrieValue(keccak256(concat([node, "0x00"])), "0x80", [node])).toThrow(/hash/);
    expect(() => readTrieValue(keccak256(node), "0x80", [])).toThrow(/ends early/);
    expect(() => readTrieValue(keccak256(node), "0x81", [node])).toThrow(/not in the trie/);
    const triple = toRlp(["0x01", "0x02", "0x03"]);
    expect(() => readTrieValue(keccak256(triple), "0x80", [triple])).toThrow(/malformed/);
    const empty: Hex[] = Array.from({ length: 17 }, () => "0x");
    const emptyBranch = toRlp(empty);
    expect(() => readTrieValue(keccak256(emptyBranch), "0x80", [emptyBranch])).toThrow(/not in the trie/);
    expect(() => readTrieValue(keccak256(emptyBranch), "0x", [emptyBranch])).toThrow(/not in the trie/);
    const shortChild = [...empty];
    shortChild[8] = "0x1234";
    const badBranch = toRlp(shortChild);
    expect(() => readTrieValue(keccak256(badBranch), "0x80", [badBranch])).toThrow(/malformed/);
    const scalar = toRlp("0x1234");
    expect(() => readTrieValue(keccak256(scalar), "0x80", [scalar])).toThrow(/malformed/);
  });
});

describe("readProvenMessage on built proofs", () => {
  const zeroHeader = { slot: 0n, proposerIndex: 0n, parentRoot: `0x${"00".repeat(32)}`, stateRoot: `0x${"00".repeat(32)}`, bodyRoot: `0x${"00".repeat(32)}` } as const;
  const keyOf = (index: bigint): Hex => (index === 0n ? "0x80" : toRlp(`0x${index.toString(16).padStart(index.toString(16).length + (index.toString(16).length % 2), "0")}`));
  // A trie with one entry: its root is a leaf with the whole key as its even path.
  const oneLeaf = (index: bigint, value: Hex) => {
    const node = toRlp([`0x20${keyOf(index).slice(2)}`, value]);
    return { root: keccak256(node), proof: [node] };
  };
  const messageBytes = (id: Hex, lengths: [number, number] = [1, 2]): Hex =>
    concat([id, `0x${"c3".padStart(40, "0")}`, `0x${"d4".padStart(40, "0")}`, "0x000493e0", `0x${lengths[0].toString(16).padStart(2, "0")}${lengths[1].toString(16).padStart(2, "0")}00`, "0x01", "0x0171"]);
  const id: Hex = `0x0005${"11".repeat(30)}`;
  const topic = keccak256(new TextEncoder().encode("UserRequestForAffirmation(bytes32,bytes)"));
  const eventData = (message: Hex) => encodeAbiParameters([{ type: "bytes" }], [message]);
  const goodLog: RlpList = [`0x${"a1".padStart(40, "0")}`, [topic, id], eventData(messageBytes(id))];
  type RlpList = (Hex | RlpList)[];
  const build = (options: { receipt?: Hex; index?: bigint; transactionIndex?: bigint; logIndex?: bigint; header?: Hex } = {}): Hex => {
    const index = options.index ?? 0n;
    const receipt = options.receipt ?? concat(["0x02", toRlp(["0x01", "0x5208", "0x", [goodLog]] as never)]);
    const receipts = oneLeaf(index, receipt);
    const transactions = oneLeaf(index, "0x02c0");
    const header = options.header ?? toRlp(["0x", "0x", "0x", "0x", transactions.root, receipts.root]);
    return encodeFunctionData({
      abi: messageBridgeAbi,
      functionName: "executeMessage",
      args: [{ anchorHeader: zeroHeader, sourceHeader: zeroHeader, ancestryBranch: [], blockHashBranch: [], sourceFork: { version: "0x00000000", versionBranch: [], genesisValidatorsRootBranch: [] }, executionHeaderRlp: header, receiptProof: receipts.proof, receiptIndex: index, transactionProof: transactions.proof, transactionIndex: options.transactionIndex ?? index, logIndex: options.logIndex ?? 0n }],
    });
  };
  const receiptWith = (log: RlpList | Hex, status: Hex = "0x01"): Hex => toRlp([status, "0x5208", "0x", [log]] as never);

  it("reads a typed and a legacy receipt at several indexes", () => {
    for (const index of [0n, 1n, 0x10n, 0x100n]) {
      const proven = readProvenMessage(build({ index }));
      expect(proven.messageId).toBe(id);
      expect(proven.sourceTransactionHash).toBe(keccak256("0x02c0"));
      expect(proven.destinationChainId).toBe(0x171n);
    }
    expect(readProvenMessage(build({ receipt: receiptWith(goodLog) })).messageId).toBe(id);
  });

  it("refuses each malformed part", () => {
    const refuses = (calldata: Hex, reason: RegExp) => expect(() => readProvenMessage(calldata)).toThrow(reason);
    refuses(build({ transactionIndex: 1n }), /different indexes/);
    refuses(build({ header: toRlp("0x1234") }), /execution header is malformed/);
    refuses(build({ header: toRlp(["0x", "0x", "0x", "0x", ["0x"], "0x"] as never) }), /execution header is malformed/);
    refuses(build({ receipt: "0x" }), /key is not in the trie|receipt is empty/);
    refuses(build({ receipt: toRlp(["0x01"]) }), /receipt is malformed/);
    refuses(build({ receipt: receiptWith(goodLog, "0x") }), /failed transaction/);
    refuses(build({ receipt: toRlp(["0x01", "0x", "0x", "0x"]) }), /out of range/);
    refuses(build({ logIndex: 1n }), /out of range/);
    refuses(build({ receipt: receiptWith(["0x", "0x"]) }), /log is malformed/);
    refuses(build({ receipt: receiptWith([goodLog[0]!, "0x", goodLog[2]!]) }), /topics of a message/);
    refuses(build({ receipt: receiptWith([goodLog[0]!, [[topic], id], goodLog[2]!]) }), /log is malformed/);
    refuses(build({ receipt: receiptWith([goodLog[0]!, [topic, [id]], goodLog[2]!]) }), /log is malformed/);
    refuses(build({ receipt: receiptWith([goodLog[0]!, [id, id], goodLog[2]!]) }), /not a message request/);
    refuses(build({ receipt: receiptWith([goodLog[0]!, [topic, id], "0x00"]) }), /event data is malformed/);
    refuses(build({ receipt: receiptWith([goodLog[0]!, [topic, id], concat([encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [32n, 999n])])]) }), /event data is malformed/);
    refuses(build({ receipt: receiptWith([goodLog[0]!, [topic, id], encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [64n, 0n])]) }), /event data is malformed/);
    refuses(build({ receipt: receiptWith([goodLog[0]!, [topic, id], eventData("0x01")]) }), /message is malformed/);
    for (const lengths of [[0, 2], [33, 2], [1, 0], [1, 33]] as [number, number][]) {
      refuses(build({ receipt: receiptWith([goodLog[0]!, [topic, id], eventData(messageBytes(id, lengths))]) }), /message is malformed/);
    }
    refuses(build({ receipt: receiptWith([goodLog[0]!, [topic, id], eventData(messageBytes(id, [1, 30]))]) }), /message is malformed/);
    refuses(build({ receipt: receiptWith([goodLog[0]!, [topic, `0x0005${"22".repeat(30)}`], goodLog[2]!]) }), /differs from the one in the log topic/);
    refuses(encodeFunctionData({ abi: messageBridgeAbi, functionName: "BLOCK_ROOTS_VECTOR_DEPTH" }), /not a call to executeMessage/);
  });

  it("refuses leaves that do not hold a value for the key", () => {
    const listValue = toRlp(["0x2080", ["0x01"]] as never);
    expect(() => readTrieValue(keccak256(listValue), "0x80", [listValue])).toThrow(/not in the trie/);
    const node = toRlp(["0x2080", `0x${"ab".repeat(40)}`]);
    expect(() => readTrieValue(keccak256(node), "0x8000", [node])).toThrow(/not in the trie/);
    const noPath = toRlp(["0x", `0x${"ab".repeat(40)}`]);
    expect(() => readTrieValue(keccak256(noPath), "0x80", [noPath])).toThrow(/malformed/);
  });
});
