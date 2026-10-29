/**
 * Red team, 2026-10-29: attacks on `readProvenMessage` and on `planMessageExecution`, which the web and the terminal
 * use to tell which message an `executeMessage` signature delivers.
 *
 * The question for every attack: is there an input that the client reads as message X while the contract
 * (`MessageBridge.executeMessage`, `BeaconProofVerifier`, `ReceiptLogs`, the vendored Optimism `MerkleTrie`) delivers
 * message Y? A divergence where the client accepts and the contract reverts costs the signer gas only; it is reported
 * as such.
 *
 * The proofs here are synthetic: the execution header carries roots of tries that this file builds. The client does
 * not check the beacon part, so it reads them; the contract would refuse every one of them on the block hash branch.
 * That is fine for these tests, because each one asks how the client reads the receipt and log parts.
 */
import { concat, encodeAbiParameters, encodeFunctionData, keccak256, numberToHex, toRlp, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { messageBridgeAbi } from "../../src/abis/index.js";
import { planMessageExecution, type OperatorChain } from "../../src/operator.js";
import { readProvenMessage, readTrieValue } from "../../src/proven-message.js";

type Rlp = Hex | readonly Rlp[];

const TOPIC = keccak256(new TextEncoder().encode("UserRequestForAffirmation(bytes32,bytes)"));
const BRIDGE_A: Hex = "0x00000000000000000000000000000000000000a1"; // the remote bridge on the source chain
const FAKE_EMITTER: Hex = "0x00000000000000000000000000000000000000ee";
const word = (digit: string): Hex => `0x${digit.repeat(64)}`;

// --------------------------------------------------------------------------------------------------- builders

/** The trie key of an index, as `_encodeUint` in BeaconProofVerifier writes it. */
const contractKey = (index: bigint): Hex => {
  if (index === 0n) return "0x80";
  if (index < 0x80n) return numberToHex(index, { size: 1 });
  const digits = index.toString(16);
  const body = `${digits.length % 2 === 1 ? "0" : ""}${digits}`;
  return `0x${(0x80 + body.length / 2).toString(16)}${body}` as Hex;
};

/** Hex-prefix encoding of a leaf path. */
const leafPath = (key: Hex, flagBase = 2): Hex => {
  const nibbles = [...key.slice(2)];
  const odd = nibbles.length % 2 === 1;
  return `0x${odd ? `${flagBase + 1}` : `${flagBase}0`}${nibbles.join("")}` as Hex;
};

type MessageFields = {
  messageId?: Hex;
  sender?: Hex;
  executor?: Hex;
  gasLimit?: number;
  sourceChainId?: number;
  destinationChainId?: number;
  dataType?: number;
  data?: Hex;
};

const minimalBytes = (value: number): Hex => {
  const digits = value.toString(16);
  return `0x${digits.length % 2 === 1 ? "0" : ""}${digits}` as Hex;
};

// A message identifier with the version prefix 0x00050000 and a nonce.
const ID_X: Hex = `0x00050000${"11".repeat(24)}00000001`;
const ID_Y: Hex = `0x00050000${"11".repeat(24)}00000002`;

const encodeMessage = (fields: MessageFields = {}): Hex => {
  const source = minimalBytes(fields.sourceChainId ?? 1);
  const destination = minimalBytes(fields.destinationChainId ?? 369);
  return concat([
    fields.messageId ?? ID_X,
    fields.sender ?? "0x00000000000000000000000000000000000000c3",
    fields.executor ?? "0x00000000000000000000000000000000000000d4",
    numberToHex(fields.gasLimit ?? 300_000, { size: 4 }),
    numberToHex((source.length - 2) / 2, { size: 1 }),
    numberToHex((destination.length - 2) / 2, { size: 1 }),
    numberToHex(fields.dataType ?? 0, { size: 1 }),
    source,
    destination,
    fields.data ?? "0xabcdef",
  ]);
};

type LogSpec = { emitter?: Hex; topics?: readonly Hex[]; data?: Hex; message?: MessageFields };
const log = (spec: LogSpec = {}): Rlp => {
  const encoded = encodeMessage(spec.message);
  const id = spec.message?.messageId ?? ID_X;
  return [spec.emitter ?? BRIDGE_A, spec.topics ?? [TOPIC, id], spec.data ?? encodeAbiParameters([{ type: "bytes" }], [encoded])];
};

type ReceiptSpec = { type?: number | null; status?: Hex; logs?: readonly Rlp[]; rawFields?: Hex };
const receipt = (spec: ReceiptSpec = {}): Hex => {
  const body = spec.rawFields ?? toRlp([spec.status ?? "0x01", "0x5208", `0x${"00".repeat(256)}`, (spec.logs ?? [log()]) as Rlp[]] as never);
  const type = spec.type === undefined ? 2 : spec.type;
  return type === null ? body : concat([numberToHex(type, { size: 1 }), body]);
};

const TRANSACTION: Hex = `0x02${"ab".repeat(120)}`;

type ProofSpec = {
  receipt?: Hex;
  receiptIndex?: bigint;
  transactionIndex?: bigint;
  logIndex?: bigint;
  receiptProofExtra?: readonly Hex[];
  receiptLeaf?: (key: Hex, value: Hex) => Hex;
  header?: (receiptsRoot: Hex, transactionsRoot: Hex) => Hex;
};

const standardHeader = (receiptsRoot: Hex, transactionsRoot: Hex): Hex =>
  toRlp([word("1"), word("2"), "0x00000000000000000000000000000000000000f1", word("3"), transactionsRoot, receiptsRoot, `0x${"00".repeat(256)}`, "0x", "0x0f", "0x01c9c380", "0x5208", "0x6553f100", "0x", word("4"), "0x0000000000000000", "0x07"]);

const beaconHeader = (slot: bigint) => ({ slot, proposerIndex: 7n, parentRoot: word("a"), stateRoot: word("b"), bodyRoot: word("c") });

/** Calldata of executeMessage around a one-leaf receipts trie and a one-leaf transactions trie. */
const calldataOf = (spec: ProofSpec = {}): Hex => {
  const receiptIndex = spec.receiptIndex ?? 0n;
  const key = contractKey(receiptIndex);
  const leafOf = spec.receiptLeaf ?? ((k: Hex, value: Hex) => toRlp([leafPath(k), value]));
  const receiptLeaf = leafOf(key, spec.receipt ?? receipt());
  const transactionLeaf = toRlp([leafPath(contractKey(spec.transactionIndex ?? receiptIndex)), TRANSACTION]);
  const header = (spec.header ?? standardHeader)(keccak256(receiptLeaf), keccak256(transactionLeaf));
  return encodeFunctionData({
    abi: messageBridgeAbi,
    functionName: "executeMessage",
    args: [
      {
        anchorHeader: beaconHeader(14_100_000n),
        sourceHeader: beaconHeader(14_099_000n),
        ancestryBranch: [word("4")],
        blockHashBranch: [word("6")],
        executionHeaderRlp: header,
        receiptProof: [receiptLeaf, ...(spec.receiptProofExtra ?? [])],
        receiptIndex,
        transactionProof: [transactionLeaf],
        transactionIndex: spec.transactionIndex ?? receiptIndex,
        logIndex: spec.logIndex ?? 0n,
      },
    ],
  });
};

// --------------------------------------------------------------------------------------------------- the attacks

describe("readProvenMessage: does the client read the message the contract delivers?", () => {
  it("ATTACK control: the synthetic builder gives a proof that the client reads as message X", () => {
    expect(readProvenMessage(calldataOf()).messageId).toBe(ID_X.toLowerCase());
  });

  it("ATTACK log index selects the second message: the client reads Y, not the first message X (BLOCKED)", () => {
    const logs = [log(), log({ message: { messageId: ID_Y, executor: "0x00000000000000000000000000000000000000d9" } })];
    const proven = readProvenMessage(calldataOf({ receipt: receipt({ logs }), logIndex: 1n }));
    expect(proven.messageId).toBe(ID_Y.toLowerCase());
    expect(proven.executor).toBe("0x00000000000000000000000000000000000000D9");
  });

  it.each([
    ["one past the last log", 1n],
    ["2**64", 2n ** 64n],
    ["2**256 - 1", 2n ** 256n - 1n],
  ])("ATTACK log index %s is refused (BLOCKED, the contract reverts LogIndexOutOfRange)", (_, logIndex) => {
    expect(() => readProvenMessage(calldataOf({ logIndex }))).toThrow(/log index is out of range/);
  });

  it("ATTACK more than 32 logs: the client reads log 40 like ReceiptLogs.itemAt (BLOCKED, no 32-item cap)", () => {
    const logs = Array.from({ length: 41 }, (_, index) => log({ message: { messageId: `0x00050000${"22".repeat(24)}${index.toString(16).padStart(8, "0")}` } }));
    expect(readProvenMessage(calldataOf({ receipt: receipt({ logs }), logIndex: 40n })).messageId).toBe(`0x00050000${"22".repeat(24)}00000028`);
  });

  it.each([1n, 127n, 128n, 255n, 256n, 65_535n, 2n ** 64n])(
    "ATTACK receipt index %s: the client derives the same trie key as the contract's _encodeUint (BLOCKED)",
    (index) => {
      expect(readProvenMessage(calldataOf({ receiptIndex: index })).messageId).toBe(ID_X.toLowerCase());
    },
  );

  it("ATTACK receipt index and transaction index differ: refused (BLOCKED, the contract reverts IndexMismatch)", () => {
    expect(() => readProvenMessage(calldataOf({ receiptIndex: 1n, transactionIndex: 2n }))).toThrow(/different indexes/);
  });

  it("ATTACK proof for the key of another index (proof of index 1 presented as index 2): refused (BLOCKED)", () => {
    const leafOfIndexOne = (_key: Hex, value: Hex) => toRlp([leafPath(contractKey(1n)), value]);
    const forged = calldataOf({ receiptIndex: 2n, receiptLeaf: leafOfIndexOne });
    expect(() => readProvenMessage(forged)).toThrow(/not in the trie/);
  });

  it("ATTACK roots in other positions: receipts root at field 4 and transactions root at field 5 is refused (BLOCKED, same fields as the contract)", () => {
    const swapped = (receiptsRoot: Hex, transactionsRoot: Hex) => standardHeader(transactionsRoot, receiptsRoot);
    expect(() => readProvenMessage(calldataOf({ header: swapped }))).toThrow(/does not match the hash/);
  });

  it("ATTACK a header of five fields (no receipts root) is refused (BLOCKED, the contract reverts MalformedExecutionHeader)", () => {
    const short = (_r: Hex, transactionsRoot: Hex) => toRlp([word("1"), word("2"), "0x00000000000000000000000000000000000000f1", word("3"), transactionsRoot]);
    expect(() => readProvenMessage(calldataOf({ header: short }))).toThrow();
  });

  it("ATTACK header that is an RLP string, not a list, is refused (BLOCKED)", () => {
    expect(() => readProvenMessage(calldataOf({ header: () => toRlp(word("1")) }))).toThrow(/execution header is malformed/);
  });

  it.each([
    ["status 0", "0x"],
    ["status 2", "0x02"],
  ] as const)("ATTACK failed receipt (%s) is refused (BLOCKED, the contract reverts ReceiptFailed)", (_, status) => {
    expect(() => readProvenMessage(calldataOf({ receipt: receipt({ status }) }))).toThrow(/failed transaction/);
  });

  it("ATTACK legacy receipt (no type byte) is read like the contract reads it (BLOCKED)", () => {
    expect(readProvenMessage(calldataOf({ receipt: receipt({ type: null }) })).messageId).toBe(ID_X.toLowerCase());
  });

  it("ATTACK topic carries another identifier than the message: refused (BLOCKED, MessageIdMismatch)", () => {
    const forged = log({ topics: [TOPIC, ID_Y] });
    expect(() => readProvenMessage(calldataOf({ receipt: receipt({ logs: [forged] }) }))).toThrow(/differs from the one in the log topic/);
  });

  it.each([
    ["one topic", [TOPIC]],
    ["three topics", [TOPIC, ID_X, ID_X]],
    ["another event", [word("9"), ID_X]],
  ])("ATTACK %s is refused (BLOCKED)", (_, topics) => {
    expect(() => readProvenMessage(calldataOf({ receipt: receipt({ logs: [log({ topics })] }) }))).toThrow();
  });

  it("ATTACK event data with a moved offset (64 instead of 32) is refused (BLOCKED, MalformedEventData)", () => {
    const encoded = encodeMessage();
    const data = concat([numberToHex(64, { size: 32 }), word("0"), encodeAbiParameters([{ type: "bytes" }], [encoded]).slice(66) as Hex]);
    expect(() => readProvenMessage(calldataOf({ receipt: receipt({ logs: [log({ data })] }) }))).toThrow(/event data is malformed/);
  });

  // ------------------------------------------------------------------ divergences: the client accepts, the contract reverts

  it("ATTACK SUCCEEDS fake emitter: a log with the bridge topic from another contract is read as message X (the contract reverts WrongEmitter)", () => {
    // On the source chain anyone can deploy a contract that emits UserRequestForAffirmation with any identifier and
    // any message bytes, including the identifier, sender and executor of a real pending message X.
    const proven = readProvenMessage(calldataOf({ receipt: receipt({ logs: [log({ emitter: FAKE_EMITTER })] }) }));
    expect(proven.messageId).toBe(ID_X.toLowerCase());
  });

  it("ATTACK SUCCEEDS extra proof node after the leaf: the client ignores it (the contract reverts 'value node must be last node in proof')", () => {
    expect(readProvenMessage(calldataOf({ receiptProofExtra: [toRlp(["0x20", "0x01"])] })).messageId).toBe(ID_X.toLowerCase());
  });

  it.each([0x00, 0x05, 0x7f])(
    "ATTACK SUCCEEDS receipt type byte 0x%s: the client strips it (the contract accepts only 0x01 to 0x04 and reverts MalformedReceipt)",
    (type) => {
      expect(readProvenMessage(calldataOf({ receipt: receipt({ type }) })).messageId).toBe(ID_X.toLowerCase());
    },
  );

  it("ATTACK SUCCEEDS event data with a trailing word: the client decodes it (the contract requires the exact length, MalformedEventData)", () => {
    const data = concat([encodeAbiParameters([{ type: "bytes" }], [encodeMessage()]), word("f")]);
    expect(readProvenMessage(calldataOf({ receipt: receipt({ logs: [log({ data })] }) })).messageId).toBe(ID_X.toLowerCase());
  });

  it("ATTACK SUCCEEDS a message of an unknown version, data type or source chain is read (the contract reverts MessageVersionInvalid / UnknownDataType / WrongSourceChain)", () => {
    const badVersion: Hex = `0x99990000${"11".repeat(24)}00000001`;
    const message = { messageId: badVersion, dataType: 0x80, sourceChainId: 5 };
    const proven = readProvenMessage(calldataOf({ receipt: receipt({ logs: [log({ message, topics: [TOPIC, badVersion] })] }) }));
    expect(proven.messageId).toBe(badVersion);
    expect(proven.sourceChainId).toBe(5n);
  });

  it("ATTACK SUCCEEDS a leaf with an unknown hex-prefix flag (0x4_) is read as a leaf (the contract reverts 'unknown prefix')", () => {
    // Only a trie that the attacker builds can hold such a node, and the beacon binding stops that trie on chain.
    const leaf = (key: Hex, value: Hex) => toRlp([leafPath(key, 4), value]);
    expect(readProvenMessage(calldataOf({ receiptLeaf: leaf })).messageId).toBe(ID_X.toLowerCase());
  });

  it("ATTACK SUCCEEDS non-canonical status (0x8101 instead of 0x01) is read (the contract's RLPReader reverts InvalidHeader)", () => {
    // Hand-written receipt: list [0x8101, 0x5208, bloom, [log]]. The honest receipts trie never holds this form.
    const fields = concat(["0x8101", "0x825208", toRlp(`0x${"00".repeat(256)}`), toRlp([log()] as never)]);
    const rawFields = concat([listHeader((fields.length - 2) / 2), fields]);
    expect(readProvenMessage(calldataOf({ receipt: receipt({ rawFields }) })).messageId).toBe(ID_X.toLowerCase());
  });
});

/** An RLP list header for a payload of `length` bytes. */
function listHeader(length: number): Hex {
  if (length <= 55) return numberToHex(0xc0 + length, { size: 1 });
  const digits = length.toString(16);
  const body = `${digits.length % 2 === 1 ? "0" : ""}${digits}`;
  return `0x${(0xf7 + body.length / 2).toString(16)}${body}` as Hex;
}

describe("readTrieValue: trie edge cases", () => {
  const leaf = (path: Hex, value: Hex): Hex => toRlp([path, value]);

  it("ATTACK a node that does not hash to its parent reference is refused (BLOCKED)", () => {
    const node = leaf("0x2080", `0x${"ab".repeat(40)}`);
    expect(() => readTrieValue(keccak256(node), "0x80", [leaf("0x2080", `0x${"ac".repeat(40)}`)])).toThrow(/does not match/);
  });

  it("ATTACK a leaf whose path is a prefix of the key is refused (BLOCKED)", () => {
    const node = leaf("0x38", `0x${"ab".repeat(40)}`); // odd leaf, path [8]
    expect(() => readTrieValue(keccak256(node), "0x80", [node])).toThrow(/not in the trie/);
  });

  it("ATTACK an empty proof is refused (BLOCKED)", () => {
    expect(() => readTrieValue(word("1"), "0x80", [])).toThrow(/ends early/);
  });

  it("ATTACK a branch child of 31 bytes as a string reference is refused (BLOCKED)", () => {
    const children: Hex[] = Array.from({ length: 17 }, () => "0x");
    children[8] = `0x${"aa".repeat(31)}`;
    const branch = toRlp(children);
    expect(() => readTrieValue(keccak256(branch), "0x80", [branch])).toThrow(/malformed/);
  });

  it("ATTACK an empty value in a branch is 'not in the trie' (BLOCKED, the contract refuses an empty value too)", () => {
    const children: Hex[] = Array.from({ length: 17 }, () => "0x");
    children[0] = word("5");
    const branch = toRlp(children);
    expect(() => readTrieValue(keccak256(branch), "0x", [branch])).toThrow(/not in the trie/);
  });
});

// --------------------------------------------------------------------------------------------------- operator plan

const bridge = "0x00000000000000000000000000000000000000b2" as const;
const lightClient = "0x00000000000000000000000000000000000000c2" as const;
const chains: readonly OperatorChain[] = [
  { chainId: 1, name: "Ethereum", lightClient: "0x00000000000000000000000000000000000000c1", messageBridge: "0x00000000000000000000000000000000000000b1" },
  { chainId: 369, name: "PulseChain", lightClient, messageBridge: bridge },
];

const evidence = (calldata: Hex, changes: Record<string, unknown> = {}): string => {
  const proven = readProvenMessage(calldata);
  return JSON.stringify({
    schemaVersion: 2,
    route: "ethereum_to_pulsechain",
    sourceTransactionHash: proven.sourceTransactionHash,
    logIndex: 0,
    message: { messageId: proven.messageId, sender: proven.sender, executor: proven.executor, gasLimit: Number(proven.gasLimit), dataType: 0, data: "0xabcdef", sourceBlockNumber: 15, sourceBlockHash: word("d"), sourceSlot: 14_099_000 },
    destination: { chainId: 369, bridge, lightClient },
    anchor: { slot: 14_100_000, root: word("e") },
    deliveryStatus: "notDelivered",
    alreadyDelivered: false,
    execute: { to: bridge, data: calldata },
    prerequisites: [],
    ...changes,
  });
};

describe("planMessageExecution: can a hostile evidence file make the user sign something else?", () => {
  it("ATTACK evidence for another destination chain (message names chain 1, file says PulseChain) is refused (BLOCKED)", () => {
    const calldata = calldataOf({ receipt: receipt({ logs: [log({ message: { destinationChainId: 1 } })] }) });
    expect(() => planMessageExecution(evidence(calldata), chains)).toThrow(/for chain 1/);
  });

  it("ATTACK labels of another message (file says Y, proof proves X) are refused (BLOCKED)", () => {
    const calldata = calldataOf();
    const lying = evidence(calldata, { message: { ...JSON.parse(evidence(calldata)).message, messageId: ID_Y } });
    expect(() => planMessageExecution(lying, chains)).toThrow(/messageId in the file/);
  });

  it("ATTACK SUCCEEDS fake-emitter proof passes the plan: the review shows message X, the transaction reverts WrongEmitter", () => {
    const calldata = calldataOf({ receipt: receipt({ logs: [log({ emitter: FAKE_EMITTER })] }) });
    const plan = planMessageExecution(evidence(calldata), chains);
    expect(plan.summary.messageId).toBe(ID_X.toLowerCase());
  });

  it("ATTACK SUCCEEDS wrong source chain passes the plan (route label is the file's word; the contract reverts WrongSourceChain)", () => {
    const calldata = calldataOf({ receipt: receipt({ logs: [log({ message: { sourceChainId: 943 } })] }) });
    const plan = planMessageExecution(evidence(calldata, { route: "ethereum_to_pulsechain" }), chains);
    expect(plan.summary.route).toBe("ethereum_to_pulsechain");
  });

  it("ATTACK SUCCEEDS the source slot and anchor slot shown in the summary are not bound to the calldata", () => {
    const calldata = calldataOf(); // anchor slot 14_100_000, source slot 14_099_000 in the calldata
    const plan = planMessageExecution(evidence(calldata, { anchor: { slot: 1, root: word("e") }, message: { ...JSON.parse(evidence(calldata)).message, sourceSlot: 2 } }), chains);
    expect(plan.summary.anchorSlot).toBe(1n);
    expect(plan.summary.sourceSlot).toBe(2n);
  });

  it("ATTACK a send (requireToPassMessage) offered as a prerequisite is refused (BLOCKED, was S-1)", () => {
    const send = encodeFunctionData({
      abi: messageBridgeAbi,
      functionName: "requireToPassMessage",
      args: ["0x00000000000000000000000000000000000000e7", "0xdeadbeef", 500_000n],
    });
    const file = evidence(calldataOf(), { prerequisites: [{ function: "requireToPassMessage", reason: "no validated block hash row covers the source slot", to: bridge, data: send }] });
    expect(() => planMessageExecution(file, chains)).toThrow(/Prerequisite 0 calls requireToPassMessage, which does not add a layout row/);
  });

  it("ATTACK executeMessage of another message offered as a prerequisite is refused (BLOCKED, was S-2)", () => {
    const other = calldataOf({ receipt: receipt({ logs: [log({ message: { messageId: ID_Y }, topics: [TOPIC, ID_Y] })] }) });
    const file = evidence(calldataOf(), { prerequisites: [{ function: "executeMessage", reason: "layout", to: bridge, data: other }] });
    expect(() => planMessageExecution(file, chains)).toThrow(/Prerequisite 0 calls executeMessage, which does not add a layout row/);
  });

  it("ATTACK an already delivered message is refused even when alreadyDelivered is the string 'false' (BLOCKED)", () => {
    expect(() => planMessageExecution(evidence(calldataOf(), { alreadyDelivered: "false" }), chains)).toThrow(/already delivered/);
  });
});

