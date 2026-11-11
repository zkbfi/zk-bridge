import { readFileSync } from "node:fs";
import { join } from "node:path";
import { encodeAbiParameters, encodeFunctionData, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import {
  OperatorFileError,
  beaconLightClientAbi,
  encodeUpdateCalldata,
  messageBridgeAbi,
  planMessageExecution,
  planUpdateFromHandoff,
  planUpdateFromProofMessage,
  proofStartProblem,
  type OperatorChain,
  type ProofMessage,
} from "../src/index.js";

const lightClient = "0x00000000000000000000000000000000000000c2" as const;
const bridge = "0x00000000000000000000000000000000000000b2" as const;
const chains: readonly OperatorChain[] = [
  { chainId: 1, name: "Ethereum", lightClient: "0x00000000000000000000000000000000000000c1", messageBridge: "0x00000000000000000000000000000000000000b1" },
  { chainId: 369, name: "PulseChain", lightClient, messageBridge: bridge },
];

const lightClientOutputParameters = [
  { name: "genesisValidatorsRoot", type: "bytes32" },
  { name: "previousHeaderRoot", type: "bytes32" },
  { name: "previousHeadSlot", type: "uint64" },
  { name: "previousSyncCommitteeHash", type: "bytes32" },
  { name: "startNextSyncCommitteeHash", type: "bytes32" },
  { name: "newHeaderRoot", type: "bytes32" },
  { name: "newHeadSlot", type: "uint64" },
  { name: "executionBlockHash", type: "bytes32" },
  { name: "executionBlockNumber", type: "uint64" },
  { name: "syncCommitteeHash", type: "bytes32" },
  { name: "nextSyncCommitteeHash", type: "bytes32" },
] as const;

const word = (digit: string): Hex => `0x${digit.repeat(64)}`
const header = (slot: bigint) => ({
  slot,
  proposerIndex: 5n,
  parentRoot: word('1'),
  stateRoot: word('2'),
  bodyRoot: word('3'),
})

const START_SLOT = 14_099_840
const NEW_SLOT = 14_100_000

function publicValues(overrides: { previousHeadSlot?: bigint; newHeadSlot?: bigint } = {}): Hex {
  return encodeAbiParameters(lightClientOutputParameters, [
    word('a'),
    word('b'),
    overrides.previousHeadSlot ?? BigInt(START_SLOT),
    word('c'),
    word('d'),
    word('e'),
    overrides.newHeadSlot ?? BigInt(NEW_SLOT),
    word('f'),
    21_000_000n,
    word('9'),
    word('8'),
  ])
}

function handoff(changes: Record<string, unknown> = {}, values: Hex = publicValues()): string {
  const proof: Hex = `0x${'12'.repeat(260)}`
  return JSON.stringify({
    schemaVersion: 1,
    route: 'ethereum_to_pulsechain',
    programKey: word('9'),
    startHeadSlot: START_SLOT,
    startHeadRoot: word('b'),
    newHeadSlot: NEW_SLOT,
    newHeadRoot: word('e'),
    latestFinalizedSlot: NEW_SLOT,
    publicValues: values,
    proof,
    updateCalldata: encodeUpdateCalldata(proof, values),
    backend: 'remote',
    destination: { chainId: 369, lightClient },
    createdAt: '2026-10-24T09:30:00Z',
    ...changes,
  })
}

describe('planUpdateFromHandoff', () => {
  it('plans the update call to the configured light client of the destination', () => {
    const plan = planUpdateFromHandoff(handoff(), chains)
    expect(plan.to).toBe(lightClient)
    expect(plan.chainId).toBe(369)
    expect(plan.functionSignature).toBe('update(bytes,bytes)')
    expect(plan.title).toContain('PulseChain')
    expect(plan.arguments.find((argument) => argument.name === 'publicValues.newHeadSlot')?.value).toBe(String(NEW_SLOT))
    expect(plan.notes[0]).toContain(`from slot ${START_SLOT} to slot ${NEW_SLOT}`)
  })

  it('the calldata sent is the calldata in the file, byte for byte', () => {
    const text = handoff()
    expect(planUpdateFromHandoff(text, chains).data).toBe(JSON.parse(text).updateCalldata)
  })

  it('refuses a destination that is not the configured light client', () => {
    const other = '0x0000000000000000000000000000000000009999'
    expect(() => planUpdateFromHandoff(handoff({ destination: { chainId: 369, lightClient: other } }), chains)).toThrow(OperatorFileError)
  })

  it('refuses a destination chain that is not in the pair, and a file with no destination', () => {
    expect(() => planUpdateFromHandoff(handoff({ destination: { chainId: 56, lightClient } }), chains)).toThrow(OperatorFileError)
    expect(() => planUpdateFromHandoff(handoff({ destination: undefined }), chains)).toThrow(OperatorFileError)
  })

  it('refuses a file whose slots differ from its own public values', () => {
    expect(() => planUpdateFromHandoff(handoff({ newHeadSlot: NEW_SLOT + 1 }), chains)).toThrow(/newHeadSlot/)
    expect(() => planUpdateFromHandoff(handoff({ startHeadSlot: START_SLOT - 1 }), chains)).toThrow(/previousHeadSlot/)
    expect(() => planUpdateFromHandoff(handoff({ newHeadRoot: word('0') }), chains)).toThrow(/newHeaderRoot/)
  })

  it('refuses calldata that does not carry the proof and public values of the file', () => {
    const swapped = encodeUpdateCalldata(`0x${'34'.repeat(260)}`, publicValues())
    expect(() => planUpdateFromHandoff(handoff({ updateCalldata: swapped }), chains)).toThrow(/proof/)
    expect(() => planUpdateFromHandoff(handoff({ updateCalldata: '0x12345678' }), chains)).toThrow(/update\(bytes,bytes\)/)
  })

  it('refuses public values of the wrong length, a wrong schema version, and text that is not JSON', () => {
    const short: Hex = '0x1234'
    const proof: Hex = `0x${'12'.repeat(260)}`
    expect(() => planUpdateFromHandoff(handoff({ publicValues: short, updateCalldata: encodeUpdateCalldata(proof, short) }, short), chains)).toThrow(/352/)
    expect(() => planUpdateFromHandoff(handoff({ schemaVersion: 2 }), chains)).toThrow(/schemaVersion/)
    expect(() => planUpdateFromHandoff('not json', chains)).toThrow(/JSON/)
  })
})

// A contract test vector of the light client: real executeMessage calldata and the message that it delivers.
const vector = JSON.parse(
  readFileSync(join(import.meta.dirname, "../../../light-client/tests/fixtures/message/electra_accept_second_message_in_same_receipt.json"), "utf8"),
) as { calldata: Hex; expected: { message: { messageId: Hex; sourceTransactionHash: Hex } } }
const provenId = vector.expected.message.messageId

/** A fork proof of a source state (`MessageProof.sourceFork`, and the `fork` of block hash layout evidence). */
const forkProof = { version: '0x07000000' as Hex, versionBranch: [word('9')], genesisValidatorsRootBranch: [word('a')] }

function executeCall(logIndex: bigint, rlp: Hex = '0xf90211', blockHashBranch: Hex[] = [word('6')]): Hex {
  return encodeFunctionData({
    abi: messageBridgeAbi,
    functionName: 'executeMessage',
    args: [
      {
        anchorHeader: header(14_100_000n),
        sourceHeader: header(14_099_000n),
        ancestryBranch: [word('4'), word('5')],
        blockHashBranch,
        sourceFork: forkProof,
        executionHeaderRlp: rlp,
        receiptProof: ['0x01', '0x02'],
        receiptIndex: 3n,
        transactionProof: ['0x03'],
        transactionIndex: 3n,
        logIndex,
      },
    ],
  })
}

function prerequisiteCall(): Hex {
  return encodeFunctionData({
    abi: messageBridgeAbi,
    functionName: 'addBlockHashLayout',
    args: [(2n ** 4n + 9n) * 2n ** 4n + 12n, { header: header(14_099_840n), branch: [word('7'), word('8')], fork: forkProof }],
  })
}

function evidence(changes: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 2,
    route: 'ethereum_to_pulsechain',
    sourceTransactionHash: vector.expected.message.sourceTransactionHash,
    logIndex: 2,
    message: {
      messageId: provenId,
      sender: '0x00000000000000000000000000000000000000c3',
      executor: '0x00000000000000000000000000000000000000d4',
      gasLimit: 300_000,
      dataType: 0,
      data: '0xabcdef',
      sourceBlockNumber: 15,
      sourceBlockHash: word('d'),
      sourceSlot: 14_099_000,
    },
    destination: { chainId: 369, bridge, lightClient },
    anchor: { slot: 14_100_000, root: word('e') },
    deliveryStatus: 'notDelivered',
    alreadyDelivered: false,
    execute: { to: bridge, data: vector.calldata },
    prerequisites: [
      { function: 'addBlockHashLayout', reason: 'no validated block hash row covers the source slot', to: bridge, data: prerequisiteCall() },
    ],
    createdAt: '2026-10-24T09:31:00Z',
    ...changes,
  })
}

describe('planMessageExecution', () => {
  it('puts the prerequisites first and the execution last, all against the configured bridge', () => {
    const { steps, summary } = planMessageExecution(evidence(), chains)
    expect(steps.map((step) => step.role)).toEqual(['prerequisite', 'execute'])
    expect(steps.every((step) => step.call.to === bridge && step.call.chainId === 369)).toBe(true)
    expect(steps[0]?.reason).toContain('no validated block hash row')
    expect(summary.messageId).toBe(provenId)
    expect(summary.sourceSlot).toBe(14_099_000n)
    expect(summary.anchorSlot).toBe(14_100_000n)
  })

  it('shows the decoded proof of the execution, not just the bytes', () => {
    const { steps } = planMessageExecution(evidence(), chains)
    const names = steps[1]?.call.arguments.map((argument) => argument.name) ?? []
    expect(names).toContain('proof.anchorHeader.slot')
    expect(names).toContain('proof.sourceHeader.slot')
    expect(names).toContain('proof.logIndex')
    expect(steps[1]?.call.arguments.find((argument) => argument.name === 'proof.logIndex')?.value).toBe('2')
  })

  it('refuses a message that is already delivered', () => {
    for (const changes of [
      { alreadyDelivered: true, deliveryStatus: 'succeeded' },
      { alreadyDelivered: false, deliveryStatus: 'failed' },
    ]) {
      expect(() => planMessageExecution(evidence(changes), chains)).toThrow(/already delivered/)
    }
  })

  it('refuses an execution that targets another contract than the configured bridge', () => {
    const other = '0x0000000000000000000000000000000000009999'
    expect(() => planMessageExecution(evidence({ execute: { to: other, data: executeCall(1n) } }), chains)).toThrow(OperatorFileError)
    expect(() => planMessageExecution(evidence({ destination: { chainId: 369, bridge: other, lightClient } }), chains)).toThrow(OperatorFileError)
  })

  it('refuses an execution whose proof names another log than the file says', () => {
    expect(() => planMessageExecution(evidence({ logIndex: 1 }), chains)).toThrow(/logIndex/)
  })

  it('takes the message from the proof in the calldata, and refuses a file whose labels name another message', () => {
    const message = JSON.parse(evidence()).message as Record<string, unknown>
    for (const [changes, field] of [
      [{ message: { ...message, messageId: word('c') } }, /messageId/],
      [{ sourceTransactionHash: word('a') }, /sourceTransactionHash/],
      [{ message: { ...message, sender: '0x0000000000000000000000000000000000000abc' } }, /sender/],
      [{ message: { ...message, executor: '0x0000000000000000000000000000000000000abd' } }, /executor/],
    ] as const) {
      expect(() => planMessageExecution(evidence(changes), chains)).toThrow(field)
    }
  })

  it('refuses a proof of a message for the other chain of the pair', () => {
    const first = chains[0] as OperatorChain
    const elsewhere = { destination: { chainId: 1, bridge: first.messageBridge, lightClient: first.lightClient }, execute: { to: first.messageBridge, data: vector.calldata } }
    expect(() => planMessageExecution(evidence(elsewhere), chains)).toThrow(/for chain 369, not for Ethereum/)
  })

  it('refuses an executeMessage call whose proof proves no message', () => {
    expect(() => planMessageExecution(evidence({ logIndex: 1, execute: { to: bridge, data: executeCall(1n) } }), chains)).toThrow(/does not prove a message/)
  })

  it('refuses calldata that is not executeMessage, and a prerequisite that is not a bridge call', () => {
    expect(() => planMessageExecution(evidence({ execute: { to: bridge, data: prerequisiteCall() } }), chains)).toThrow(/executeMessage/)
    const unknown = { function: 'addBlockHashLayout', reason: 'x', to: bridge, data: '0x12345678' }
    expect(() => planMessageExecution(evidence({ prerequisites: [unknown] }), chains)).toThrow(/known message bridge call/)
  })

  it('refuses a prerequisite whose named function differs from its calldata', () => {
    const mislabeled = { function: 'addBlockRootsLayout', reason: 'x', to: bridge, data: prerequisiteCall() }
    expect(() => planMessageExecution(evidence({ prerequisites: [mislabeled] }), chains)).toThrow(/differs/)
  })

  it('an empty prerequisite list leaves only the execution', () => {
    expect(planMessageExecution(evidence({ prerequisites: [] }), chains).steps).toHaveLength(1)
  })
})

describe('the fields of an evidence file are checked one by one', () => {
  const messageFor = (changes: Record<string, unknown>): string => {
    try {
      planMessageExecution(evidence(changes), chains)
    } catch (error) {
      if (error instanceof OperatorFileError) return error.message
      throw error
    }
    throw new Error('the file was accepted')
  }

  it('a list of prerequisites that is not an array is refused with its path', () => {
    expect(messageFor({ prerequisites: { function: 'addBlockHashLayout' } })).toBe('evidence.prerequisites must be an array.')
  })

  it('a text field that holds another type is refused with its path', () => {
    expect(messageFor({ deliveryStatus: 5 })).toBe('evidence.deliveryStatus must be a string.')
  })

  it('a number field must be a whole number of zero or more', () => {
    const expected = 'evidence.logIndex must be a non-negative integer.'
    expect(messageFor({ logIndex: -1 })).toBe(expected)
    expect(messageFor({ logIndex: 1.5 })).toBe(expected)
    expect(messageFor({ logIndex: '1' })).toBe(expected)
  })

  it('a hex field must start with 0x and hold whole bytes', () => {
    const expected = 'evidence.execute.data must be 0x hex with whole bytes.'
    expect(messageFor({ execute: { to: bridge, data: '0x123' } })).toBe(expected)
    expect(messageFor({ execute: { to: bridge, data: '0xzz' } })).toBe(expected)
    expect(messageFor({ execute: { to: bridge, data: 'abcd' } })).toBe(expected)
  })

  it('an address field must be forty hex digits', () => {
    const expected = 'evidence.destination.bridge must be an address.'
    expect(messageFor({ destination: { chainId: 369, bridge: '0x1234', lightClient } })).toBe(expected)
    expect(messageFor({ destination: { chainId: 369, bridge: 'nope', lightClient } })).toBe(expected)
  })
})

const proofMessage = (changes: Partial<ProofMessage> = {}): ProofMessage => ({
  version: 1,
  pair: "eth-pls",
  direction: "first-to-second",
  programKey: word("9"),
  startSlot: BigInt(START_SLOT),
  startRoot: word("b"),
  newSlot: BigInt(NEW_SLOT),
  newRoot: word("e"),
  publicValues: publicValues(),
  proof: `0x${"12".repeat(356)}`,
  ...changes,
});

describe("planUpdateFromProofMessage", () => {
  it("builds update(proof, publicValues) at the chain's light client", () => {
    const message = proofMessage();
    const call = planUpdateFromProofMessage(message, chains[1] as OperatorChain);
    expect(call.to).toBe(lightClient);
    expect(call.chainId).toBe(369);
    expect(call.functionName).toBe("update");
    expect(call.functionSignature).toBe("update(bytes,bytes)");
    expect(call.data).toBe(encodeUpdateCalldata(message.proof, message.publicValues));
    expect(call.arguments.find((argument) => argument.name === "publicValues.newHeadSlot")?.value).toBe(String(NEW_SLOT));
    expect(call.notes[0]).toContain(`from slot ${START_SLOT} to slot ${NEW_SLOT}`);
  });

  it("refuses a message whose slots or roots differ from its public values", () => {
    const chain = chains[1] as OperatorChain;
    expect(() => planUpdateFromProofMessage(proofMessage({ newSlot: BigInt(NEW_SLOT + 1) }), chain)).toThrow(OperatorFileError);
    expect(() => planUpdateFromProofMessage(proofMessage({ startRoot: word("0") }), chain)).toThrow(/previousHeaderRoot/);
  });

  it("refuses public values of the wrong length", () => {
    expect(() => planUpdateFromProofMessage(proofMessage({ publicValues: "0x1234" }), chains[1] as OperatorChain)).toThrow(/352/);
  });
});

describe("the argument lists", () => {
  it("cut long bytes and summarize long arrays with a digest, and keep short ones whole", () => {
    const { steps } = planMessageExecution(evidence(), chains);
    const executeArguments = steps[1]?.call.arguments ?? [];
    expect(executeArguments.find((argument) => argument.name === "proof.executionHeaderRlp")).toMatchObject({
      meaning: "621 bytes",
      value: expect.stringContaining("keccak256"),
    });
    expect(executeArguments.find((argument) => argument.name === "proof.receiptProof")?.value).toMatch(/^keccak256 of the encoding 0x/);
    const prerequisiteArguments = steps[0]?.call.arguments ?? [];
    expect(prerequisiteArguments.find((argument) => argument.name.endsWith("branch"))?.value).toBe(`${word("7")}, ${word("8")}`);
  });
});

describe("calldata that decodes but is not the expected call", () => {
  it("refuses an updateCalldata that is another function of the light client", () => {
    const other = encodeFunctionData({ abi: beaconLightClientAbi, functionName: "genesisTime" });
    expect(() => planUpdateFromHandoff(handoff({ updateCalldata: other }), chains)).toThrow(/update\(bytes,bytes\)/);
  });

  it("refuses a prerequisite that has a known selector but arguments that do not decode", () => {
    const selector = encodeFunctionData({ abi: messageBridgeAbi, functionName: "addBlockHashLayout", args: [1n, { header: header(1n), branch: [], fork: forkProof }] }).slice(0, 10);
    const broken = { function: "addBlockHashLayout", reason: "x", to: bridge, data: `${selector}1234` };
    expect(() => planMessageExecution(evidence({ prerequisites: [broken] }), chains)).toThrow(/known message bridge call/);
  });
});

describe("a chain that is not in the list", () => {
  it("is refused with the chain id the file names", () => {
    try {
      planUpdateFromHandoff(handoff({ destination: { chainId: 56, lightClient } }), chains);
    } catch (error) {
      expect(error).toBeInstanceOf(OperatorFileError);
      expect(error).toMatchObject({ name: "OperatorChainError", chainId: 56 });
      return;
    }
    throw new Error("the file was accepted");
  });
});

describe("proofStartProblem", () => {
  it("is null for a proof that starts at the head and goes past it", () => {
    expect(proofStartProblem(proofMessage(), BigInt(START_SLOT))).toBeNull();
  });

  it("names a proof that does not go past the head, and one that starts elsewhere", () => {
    expect(proofStartProblem(proofMessage(), BigInt(NEW_SLOT))).toMatch(/already holds slot 14100000/);
    expect(proofStartProblem(proofMessage(), BigInt(START_SLOT + 32))).toMatch(/starts at slot 14099840/);
  });
});
