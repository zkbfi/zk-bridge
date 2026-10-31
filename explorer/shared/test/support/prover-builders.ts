import { encodeAbiParameters, encodeFunctionData, type Address, type Hex } from "viem";
import { encodeProofMessage, type ProofDirection, type ProofMessage } from "../../src/proof-message.js";
import { messageBridgeAbi } from "../../src/abis/index.js";
import type { EvidencePackage } from "../../src/prover/packages.js";
import type { LightClientHead, LightClientReader } from "../../src/prover/light-client.js";
import type { ProveOutcome, ProverBinary } from "../../src/prover/prover-binary.js";

/** A 32 byte word with every byte set to `seed`. */
export const word = (seed: number): Hex => `0x${seed.toString(16).padStart(2, "0").repeat(32)}`;
/** An address with every byte set to `seed`. */
export const address = (seed: number): Address => `0x${seed.toString(16).padStart(2, "0").repeat(20)}`;

export const LIGHT_CLIENT = address(0x44);
export const BRIDGE = address(0x33);
export const PROGRAM_KEY = word(0x42);

/** A logger that keeps its events, in order. */
export function memoryLogger(): {
  readonly logger: { debug(event: string, fields?: Record<string, unknown>): void; info(event: string, fields?: Record<string, unknown>): void };
  readonly events: () => Array<Record<string, unknown>>;
} {
  const kept: Array<Record<string, unknown>> = [];
  const keep = (level: string) => (event: string, fields: Record<string, unknown> = {}) => {
    kept.push({ level, event, ...fields });
  };
  return { logger: { debug: keep("debug"), info: keep("info") }, events: () => kept };
}

/** Public values for a light client update from `startSlot` to `newSlot`. */
export function publicValuesFor(startSlot: bigint, startRoot: Hex, newSlot: bigint, newRoot: Hex): Hex {
  return encodeAbiParameters(
    [
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "uint64" },
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "uint64" },
      { type: "bytes32" },
      { type: "uint64" },
      { type: "bytes32" },
      { type: "bytes32" },
    ],
    [word(1), startRoot, startSlot, word(3), word(4), newRoot, newSlot, word(5), 123n, word(6), word(7)],
  );
}

/** A proof message for an update. The proof bytes are a stand-in: the fake prover decides whether they verify. */
export function proofMessage(options: { startSlot?: bigint; newSlot?: bigint; direction?: ProofDirection; programKey?: Hex; proofByte?: string } = {}): ProofMessage {
  const startSlot = options.startSlot ?? 100n;
  const newSlot = options.newSlot ?? 164n;
  const startRoot = word(Number(startSlot % 200n) + 1);
  const newRoot = word(Number(newSlot % 200n) + 1);
  return {
    version: 1,
    pair: "eth-pls",
    direction: options.direction ?? "first-to-second",
    programKey: options.programKey ?? PROGRAM_KEY,
    startSlot,
    startRoot,
    newSlot,
    newRoot,
    publicValues: publicValuesFor(startSlot, startRoot, newSlot, newRoot),
    proof: `0x${(options.proofByte ?? "ab").repeat(356)}`,
  };
}

/** The encoded payload of {@link proofMessage}. */
export const proofPayload = (options: Parameters<typeof proofMessage>[0] = {}): Hex => encodeProofMessage(proofMessage(options));

/** A light client reader that returns what the test sets. */
export function fakeLightClient(initial: Partial<LightClientHead> = {}): LightClientReader & { state: LightClientHead; reads: number } {
  const reader = {
    state: { headSlot: 100n, headRoot: word(101), programKey: PROGRAM_KEY, ...initial },
    reads: 0,
    async read() {
      reader.reads += 1;
      return reader.state;
    },
  };
  return reader;
}

/** The calldata of `executeMessage` with an all zero proof: enough for the router to re-encode it. */
export function emptyExecuteMessage(anchorSlot = 0n): Hex {
  const item = messageBridgeAbi.find((entry) => entry.type === "function" && entry.name === "executeMessage");
  if (item === undefined || item.type !== "function") throw new Error("executeMessage is not in the ABI");
  const zeroOf = (component: { type: string; components?: readonly { type: string; name?: string; components?: readonly unknown[] }[] }): unknown => {
    if (component.type === "tuple") return Object.fromEntries((component.components ?? []).map((inner) => [(inner as { name: string }).name, zeroOf(inner as never)]));
    if (component.type.endsWith("[]")) return [];
    if (component.type === "bytes32") return word(0);
    if (component.type === "bytes") return "0x";
    if (component.type === "address") return address(0);
    if (component.type === "bool") return false;
    return 0n;
  };
  const proof = zeroOf(item.inputs[0] as never) as { anchorHeader: { slot: bigint } };
  proof.anchorHeader.slot = anchorSlot;
  return encodeFunctionData({ abi: messageBridgeAbi, functionName: "executeMessage", args: [proof as never] });
}

/** Evidence that a bridge accepts: the calldata is a real `executeMessage` call with an empty proof. */
export function evidenceFor(options: { prerequisites?: EvidencePackage["prerequisites"]; alreadyDelivered?: boolean; executeData?: Hex } = {}): EvidencePackage {
  return {
    schemaVersion: 2,
    route: "ethereum_to_pulsechain",
    sourceTransactionHash: word(0xa1),
    logIndex: 0,
    message: { messageId: word(1), sender: address(1), executor: address(2), gasLimit: 2_000_000, data: "0x" },
    destination: { chainId: 369, bridge: BRIDGE, lightClient: LIGHT_CLIENT },
    anchor: { slot: 100, root: word(101) },
    deliveryStatus: options.alreadyDelivered === true ? "succeeded" : "notDelivered",
    alreadyDelivered: options.alreadyDelivered ?? false,
    execute: { to: BRIDGE, data: options.executeData ?? emptyExecuteMessage() },
    prerequisites: options.prerequisites ?? [],
    createdAt: "2026-10-25T00:00:00Z",
  };
}

/** A prover binary whose answers the test sets. */
export function fakeProver(options: { evidence?: () => EvidencePackage | Promise<EvidencePackage>; verify?: (programKey: Hex) => void | Promise<void>; prove?: () => Promise<ProveOutcome> } = {}): ProverBinary & { evidenceRuns: number; verifications: number } {
  const prover = {
    evidenceRuns: 0,
    verifications: 0,
    async prove() {
      if (options.prove === undefined) throw new Error("prove is not expected");
      return options.prove();
    },
    async evidence() {
      prover.evidenceRuns += 1;
      return (options.evidence ?? (() => evidenceFor()))();
    },
    async verify(request: { programKey: Hex }) {
      prover.verifications += 1;
      await options.verify?.(request.programKey);
    },
  };
  return prover;
}
