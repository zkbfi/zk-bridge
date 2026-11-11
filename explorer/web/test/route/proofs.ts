import { readFileSync } from "node:fs";
import { join } from "node:path";
import { encodeAbiParameters, encodeFunctionData, type Hex } from "viem";
import { PROOF_BYTES, encodeProofMessage, type ProofMessage, type StepProof } from "@zk-bridge/shared";
import { FIXTURE_PAIR } from "@terminal/data/fixtures";
import { messageBridgeAbi } from "@terminal/tx/abis";
import { messageBridgeAbi as fullBridgeAbi } from "@zk-bridge/shared";

export const word = (digit: string): Hex => `0x${digit.repeat(64)}`;
export const HEAD = 14_100_000n;

const outputParameters = [
  { type: "bytes32" }, { type: "bytes32" }, { type: "uint64" }, { type: "bytes32" }, { type: "bytes32" },
  { type: "bytes32" }, { type: "uint64" }, { type: "bytes32" }, { type: "uint64" }, { type: "bytes32" }, { type: "bytes32" },
] as const;

/** A proof message of the first-to-second direction that starts at HEAD. */
export const proofMessage = (overrides: Partial<ProofMessage> = {}): ProofMessage => {
  const startSlot = overrides.startSlot ?? HEAD;
  const newSlot = overrides.newSlot ?? HEAD + 64n;
  return {
    version: 1, pair: "eth-pls", direction: "first-to-second", programKey: word("9"), startSlot, startRoot: word("a"), newSlot, newRoot: word("b"),
    publicValues: encodeAbiParameters(outputParameters, [word("1"), word("a"), startSlot, word("3"), word("4"), word("b"), newSlot, word("5"), 123n, word("6"), word("7")]),
    proof: `0x${"ab".repeat(PROOF_BYTES)}`,
    ...overrides,
  };
};

/** The finished proof of a light client update, as the backend serves it. */
export const lightClientProof = (overrides: Partial<ProofMessage> = {}): StepProof => {
  const message = proofMessage(overrides);
  return { kind: "light-client-update", subject: "first-to-second", chainId: FIXTURE_PAIR.second.chainId, payload: encodeProofMessage(message), startSlot: Number(message.startSlot), newSlot: Number(message.newSlot), provedAt: 1, where: "stored" };
};

export const registryProof = (): StepProof => ({
  kind: "registry-light-client-update", subject: String(FIXTURE_PAIR.second.chainId), chainId: FIXTURE_PAIR.second.chainId,
  lightClient: "0x00000000000000000000000000000000000000d9", programKey: word("a"), startSlot: 1000, startRoot: word("1"), newSlot: 1320, newRoot: word("2"), publicValues: "0x1234", proof: "0xabcdef", provedAt: 1,
});

export const openingProof = (calldata?: Hex): StepProof => ({
  kind: "open-deposits", subject: "first-to-second", chainId: FIXTURE_PAIR.second.chainId, bridge: FIXTURE_PAIR.second.contracts.messageBridge,
  calldata: calldata ?? encodeFunctionData({ abi: fullBridgeAbi, functionName: "openDeposits", args: [{ remoteSlot: 99n, remoteHeaderRlp: "0xf8", accountProof: ["0x01"], storedSlot: 90n, storageProof: ["0x02"] }] }),
  remoteSlot: 99, storedSlot: 90, remoteBlockNumber: 1234, provedAt: 1,
});

const header = (slot: bigint) => ({ slot, proposerIndex: 5n, parentRoot: word("1"), stateRoot: word("2"), bodyRoot: word("3") });
const bridge = FIXTURE_PAIR.second.contracts.messageBridge;
const vector = JSON.parse(
  readFileSync(join(import.meta.dirname, "../../../../light-client/tests/fixtures/message/electra_accept_second_message_in_same_receipt.json"), "utf8"),
) as { calldata: Hex; expected: { message: { messageId: Hex; sourceTransactionHash: Hex } } };

/** The message of the evidence. */
type EvidencePackage = Extract<StepProof, { kind: "deliver" }>["evidence"];

export const EVIDENCE_MESSAGE = vector.expected.message.messageId;

/** Evidence with one layout row and the delivery. */
export const evidenceOf = (changes: Record<string, unknown> = {}): EvidencePackage =>
  ({
    schemaVersion: 2,
    route: "ethereum_to_pulsechain",
    sourceTransactionHash: vector.expected.message.sourceTransactionHash,
    logIndex: 2,
    message: { messageId: vector.expected.message.messageId, sender: "0x00000000000000000000000000000000000000c3", executor: "0x00000000000000000000000000000000000000d4", gasLimit: 300000, dataType: 0, data: "0xabcdef", sourceBlockNumber: 15, sourceBlockHash: word("d"), sourceSlot: 14099000 },
    destination: { chainId: 369, bridge, lightClient: FIXTURE_PAIR.second.contracts.lightClient },
    anchor: { slot: 14100000, root: word("e") },
    deliveryStatus: "notDelivered",
    alreadyDelivered: false,
    execute: { to: bridge, data: vector.calldata },
    prerequisites: [
      {
        function: "addBlockHashLayout",
        reason: "no validated block hash row covers the source slot",
        to: bridge,
        data: encodeFunctionData({ abi: messageBridgeAbi, functionName: "addBlockHashLayout", args: [(2n ** 4n + 9n) * 2n ** 4n + 12n, { header: header(14099840n), branch: [word("7"), word("8")], fork: { version: "0x07000000", versionBranch: [word("9")], genesisValidatorsRootBranch: [word("a")] } }] }),
      },
    ],
    createdAt: "2026-10-24T09:31:00Z",
    ...changes,
  }) as unknown as EvidencePackage;
