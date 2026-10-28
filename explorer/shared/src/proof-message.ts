import { bytesToHex, decodeAbiParameters, hexToBytes, isHex, keccak256, stringToBytes, toHex, type Hex } from "viem";
import { PAIR_DEFINITIONS } from "./pairs.js";

/**
 * The proof message: the compact binary payload that the proof publisher posts on msgboard and the delivery runner
 * reads. One message holds one proof of one light client update.
 *
 * Layout, in bytes, with every number big endian:
 *
 * | Offset | Size | Field |
 * |---|---|---|
 * | 0 | 1 | version, always 1 |
 * | 1 | 1 | pair code (`PROOF_PAIR_CODES`) |
 * | 2 | 1 | direction: 0 first to second, 1 second to first |
 * | 3 | 32 | program key |
 * | 35 | 8 | start slot |
 * | 43 | 32 | start header root |
 * | 75 | 8 | new slot |
 * | 83 | 32 | new header root |
 * | 115 | 352 | public values (`abi.encode` of `LightClientOutput`) |
 * | 467 | 356 | proof |
 *
 * The total is 823 bytes. msgboard raises the difficulty of a message by 10,000 for each byte, so the layout holds
 * nothing that a reader can derive. The slots and roots in the header repeat fields of the public values. They stay
 * so that a reader can filter a message before it decodes the public values, and the decoder checks that both agree.
 *
 * The oracle form. Version 2 has the same layout with a proof of 65 bytes (one signature of the test oracle), 532 bytes
 * in all. It exists for local testing only. Every reader and writer refuses version 2 unless the caller sets the option
 * `acceptOracleProof`, so a real deployment keeps the strict version 1 rule: a proof of 356 bytes. The bytes of a
 * version 1 message do not change.
 */

/** The version byte of the layout above. */
export const PROOF_MESSAGE_VERSION = 1;
/** The size of the public values: eleven static words. */
export const PUBLIC_VALUES_BYTES = 352;
/** The size of the proof: the four byte selector and the Groth16 proof, as the verifier contract reads it. */
export const PROOF_BYTES = 356;
/** The version byte of the oracle form, which is for local testing only. */
export const ORACLE_PROOF_MESSAGE_VERSION = 2;
/** The size of the proof of the oracle form: one signature of 65 bytes. */
export const ORACLE_PROOF_BYTES = 65;
const HEADER_AND_VALUES_BYTES = 3 + 32 + 8 + 32 + 8 + 32 + PUBLIC_VALUES_BYTES;
/** The size of one encoded proof message of version 1. */
export const PROOF_MESSAGE_BYTES = HEADER_AND_VALUES_BYTES + PROOF_BYTES;
/** The size of one encoded proof message of the oracle form. */
export const ORACLE_PROOF_MESSAGE_BYTES = HEADER_AND_VALUES_BYTES + ORACLE_PROOF_BYTES;

/**
 * Options of the encoder and the decoder. The default is strict: only the Groth16 form passes.
 */
export type ProofMessageOptions = {
  /** Allow the oracle form (version 2). Set it only where the oracle backend or the oracle verifier is configured. */
  readonly acceptOracleProof?: boolean;
};

const FORMS = {
  [PROOF_MESSAGE_VERSION]: { proofBytes: PROOF_BYTES, totalBytes: PROOF_MESSAGE_BYTES },
  [ORACLE_PROOF_MESSAGE_VERSION]: { proofBytes: ORACLE_PROOF_BYTES, totalBytes: ORACLE_PROOF_MESSAGE_BYTES },
} as const;

/**
 * The code of each pair in a message. A code never changes meaning, so the list only grows. Zero is never a pair.
 */
export const PROOF_PAIR_CODES = { "eth-pls": 1, "sepolia-pls943": 2 } as const satisfies Readonly<Record<string, number>>;

/** The direction of a proof: which side of the pair is the source of the beacon chain that the proof follows. */
export type ProofDirection = "first-to-second" | "second-to-first";

/** The directions in the order of their codes in a message. */
export const PROOF_DIRECTIONS = ["first-to-second", "second-to-first"] as const satisfies readonly ProofDirection[];

/** One decoded proof message. Slots are unsigned 64 bit numbers, so they are `bigint`. */
export type ProofMessage = {
  /** 1 is the Groth16 form. 2 is the oracle form, for local testing only. */
  readonly version: typeof PROOF_MESSAGE_VERSION | typeof ORACLE_PROOF_MESSAGE_VERSION;
  /** The pair name, such as `eth-pls`. */
  readonly pair: string;
  readonly direction: ProofDirection;
  /** The program key that the proof is for. */
  readonly programKey: Hex;
  readonly startSlot: bigint;
  readonly startRoot: Hex;
  readonly newSlot: bigint;
  readonly newRoot: Hex;
  /** The 352 bytes of public values, as hex. */
  readonly publicValues: Hex;
  /** The proof as hex: 356 bytes in version 1, 65 bytes in version 2. */
  readonly proof: Hex;
};

/** Why a proof message is refused. */
export type ProofMessageFailure =
  | "not-hex"
  | "truncated"
  | "trailing-bytes"
  | "wrong-version"
  | "unknown-pair"
  | "unknown-direction"
  | "wrong-field-size"
  | "inconsistent-public-values";

/** A proof message cannot be encoded or decoded. `reason` tells a program what went wrong. */
export class ProofMessageError extends Error {
  override readonly name = "ProofMessageError";
  constructor(
    readonly reason: ProofMessageFailure,
    detail: string,
  ) {
    super(`${reason}: ${detail}`);
  }
}

/** The result of `tryDecodeProofMessage`. */
export type ProofMessageResult =
  | { readonly ok: true; readonly message: ProofMessage }
  | { readonly ok: false; readonly reason: ProofMessageFailure; readonly detail: string };

/** The fields of `BeaconLightClient.LightClientOutput`, with the slots as `bigint`. */
export type LightClientOutput = {
  readonly genesisValidatorsRoot: Hex;
  readonly previousHeaderRoot: Hex;
  readonly previousHeadSlot: bigint;
  readonly previousSyncCommitteeHash: Hex;
  readonly startNextSyncCommitteeHash: Hex;
  readonly newHeaderRoot: Hex;
  readonly newHeadSlot: bigint;
  readonly executionBlockHash: Hex;
  readonly executionBlockNumber: bigint;
  readonly syncCommitteeHash: Hex;
  readonly nextSyncCommitteeHash: Hex;
};

const lightClientOutputParameters = [
  { type: "bytes32", name: "genesisValidatorsRoot" },
  { type: "bytes32", name: "previousHeaderRoot" },
  { type: "uint64", name: "previousHeadSlot" },
  { type: "bytes32", name: "previousSyncCommitteeHash" },
  { type: "bytes32", name: "startNextSyncCommitteeHash" },
  { type: "bytes32", name: "newHeaderRoot" },
  { type: "uint64", name: "newHeadSlot" },
  { type: "bytes32", name: "executionBlockHash" },
  { type: "uint64", name: "executionBlockNumber" },
  { type: "bytes32", name: "syncCommitteeHash" },
  { type: "bytes32", name: "nextSyncCommitteeHash" },
] as const;

/**
 * Reads the public values of a light client update.
 *
 * @param publicValues The `abi.encode` of a `LightClientOutput`, 352 bytes.
 * @throws ProofMessageError with reason `wrong-field-size` when the length is not 352 bytes.
 */
export const decodeLightClientOutput = (publicValues: Hex): LightClientOutput => {
  if (hexToBytes(publicValues).length !== PUBLIC_VALUES_BYTES) {
    throw new ProofMessageError("wrong-field-size", `public values must be ${PUBLIC_VALUES_BYTES} bytes`);
  }
  const [
    genesisValidatorsRoot,
    previousHeaderRoot,
    previousHeadSlot,
    previousSyncCommitteeHash,
    startNextSyncCommitteeHash,
    newHeaderRoot,
    newHeadSlot,
    executionBlockHash,
    executionBlockNumber,
    syncCommitteeHash,
    nextSyncCommitteeHash,
  ] = decodeAbiParameters(lightClientOutputParameters, publicValues);
  return {
    genesisValidatorsRoot,
    previousHeaderRoot,
    previousHeadSlot,
    previousSyncCommitteeHash,
    startNextSyncCommitteeHash,
    newHeaderRoot,
    newHeadSlot,
    executionBlockHash,
    executionBlockNumber,
    syncCommitteeHash,
    nextSyncCommitteeHash,
  };
};

const sizedHex = (value: Hex, size: number, field: string): Uint8Array => {
  if (!isHex(value) || hexToBytes(value).length !== size) {
    throw new ProofMessageError("wrong-field-size", `${field} must be ${size} bytes`);
  }
  return hexToBytes(value);
};

const slotBytes = (slot: bigint, field: string): Uint8Array => {
  if (slot < 0n || slot >= 1n << 64n) throw new ProofMessageError("wrong-field-size", `${field} must fit in 64 bits`);
  return hexToBytes(toHex(slot, { size: 8 }));
};

const pairCode = (pair: string): number => {
  const code = (PROOF_PAIR_CODES as Readonly<Record<string, number>>)[pair];
  if (code === undefined) throw new ProofMessageError("unknown-pair", `pair "${pair}" has no code`);
  return code;
};

const sameHex = (left: Hex, right: Hex): boolean => left.toLowerCase() === right.toLowerCase();

const assertConsistent = (message: ProofMessage): void => {
  const output = decodeLightClientOutput(message.publicValues);
  const agrees =
    output.previousHeadSlot === message.startSlot &&
    sameHex(output.previousHeaderRoot, message.startRoot) &&
    output.newHeadSlot === message.newSlot &&
    sameHex(output.newHeaderRoot, message.newRoot);
  if (!agrees) {
    throw new ProofMessageError("inconsistent-public-values", "the slots and roots of the header differ from the public values");
  }
};

/**
 * Encodes a proof message. The encoder refuses a message that its own decoder would refuse.
 *
 * @param message The fields of the message.
 * @param options `acceptOracleProof` allows version 2. Without it, version 2 is refused.
 * @returns The 823 bytes as hex (532 bytes in the oracle form).
 * @throws ProofMessageError for an unknown pair, a field of the wrong size or a header that disagrees with the public values.
 */
export const encodeProofMessage = (message: ProofMessage, options: ProofMessageOptions = {}): Hex => {
  const form = FORMS[message.version];
  if (form === undefined || (message.version === ORACLE_PROOF_MESSAGE_VERSION && options.acceptOracleProof !== true)) {
    throw new ProofMessageError("wrong-version", `version ${message.version}`);
  }
  const direction = PROOF_DIRECTIONS.indexOf(message.direction);
  if (direction < 0) throw new ProofMessageError("unknown-direction", `direction "${message.direction}"`);
  const parts = [
    Uint8Array.of(message.version, pairCode(message.pair), direction),
    sizedHex(message.programKey, 32, "program key"),
    slotBytes(message.startSlot, "start slot"),
    sizedHex(message.startRoot, 32, "start root"),
    slotBytes(message.newSlot, "new slot"),
    sizedHex(message.newRoot, 32, "new root"),
    sizedHex(message.publicValues, PUBLIC_VALUES_BYTES, "public values"),
    sizedHex(message.proof, form.proofBytes, "proof"),
  ];
  assertConsistent(message);
  const bytes = new Uint8Array(form.totalBytes);
  parts.reduce((offset, part) => {
    bytes.set(part, offset);
    return offset + part.length;
  }, 0);
  return bytesToHex(bytes);
};

/**
 * Decodes a proof message.
 *
 * @param payload The message data as hex.
 * @param options `acceptOracleProof` allows version 2. Without it, version 2 has the reason `wrong-version`.
 * @throws ProofMessageError with the reason that the type `ProofMessageFailure` lists.
 */
export const decodeProofMessage = (payload: Hex, options: ProofMessageOptions = {}): ProofMessage => {
  if (!isHex(payload)) throw new ProofMessageError("not-hex", "the payload is not hex");
  const bytes = hexToBytes(payload);
  if (bytes.length < 1) throw new ProofMessageError("truncated", "the payload is empty");
  const version = bytes[0];
  // The oracle form passes only when the caller says so with a literal true. Every other value refuses it.
  if (version === ORACLE_PROOF_MESSAGE_VERSION && options.acceptOracleProof !== true) {
    throw new ProofMessageError("wrong-version", `version ${version} (the oracle form) is not accepted here`);
  }
  if (version !== PROOF_MESSAGE_VERSION && version !== ORACLE_PROOF_MESSAGE_VERSION) {
    throw new ProofMessageError("wrong-version", `version ${version}`);
  }
  const form = FORMS[version];
  if (bytes.length < form.totalBytes) {
    throw new ProofMessageError("truncated", `${bytes.length} bytes, expected ${form.totalBytes}`);
  }
  if (bytes.length > form.totalBytes) {
    throw new ProofMessageError("trailing-bytes", `${bytes.length} bytes, expected ${form.totalBytes}`);
  }
  const pair = Object.entries(PROOF_PAIR_CODES).find(([, code]) => code === bytes[1])?.[0];
  if (pair === undefined) throw new ProofMessageError("unknown-pair", `pair code ${bytes[1]}`);
  const direction = PROOF_DIRECTIONS[bytes[2] as number];
  if (direction === undefined) throw new ProofMessageError("unknown-direction", `direction code ${bytes[2]}`);
  const slice = (start: number, size: number): Hex => bytesToHex(bytes.subarray(start, start + size));
  const message: ProofMessage = {
    version,
    pair,
    direction,
    programKey: slice(3, 32),
    startSlot: BigInt(slice(35, 8)),
    startRoot: slice(43, 32),
    newSlot: BigInt(slice(75, 8)),
    newRoot: slice(83, 32),
    publicValues: slice(115, PUBLIC_VALUES_BYTES),
    proof: slice(115 + PUBLIC_VALUES_BYTES, form.proofBytes),
  };
  assertConsistent(message);
  return message;
};

/**
 * Decodes a proof message without throwing, for a reader that ignores what it cannot use.
 *
 * @param payload The message data as hex.
 * @param options The same options as {@link decodeProofMessage}. The default is strict.
 */
export const tryDecodeProofMessage = (payload: Hex, options: ProofMessageOptions = {}): ProofMessageResult => {
  try {
    return { ok: true, message: decodeProofMessage(payload, options) };
  } catch (error) {
    if (!(error instanceof ProofMessageError)) throw error;
    return { ok: false, reason: error.reason, detail: error.message };
  }
};

/**
 * The msgboard category name of a pair and direction, for example
 * `zk-bridge/eth-pls/ethereum-to-pulsechain/light-client-update/v1`.
 *
 * @param pair The pair name.
 * @param direction The direction of the proof.
 * @throws ProofMessageError with reason `unknown-pair` when the registry has no such pair.
 */
export const proofCategoryName = (pair: string, direction: ProofDirection): string => {
  const definition = PAIR_DEFINITIONS.find((candidate) => candidate.name === pair);
  if (definition === undefined) throw new ProofMessageError("unknown-pair", `pair "${pair}" is not in the registry`);
  const [source, destination] =
    direction === "first-to-second" ? definition.sides : [definition.sides[1], definition.sides[0]];
  return `zk-bridge/${pair}/${source.name}-to-${destination.name}/light-client-update/v${PROOF_MESSAGE_VERSION}`;
};

/**
 * The msgboard category of a pair and direction: the keccak256 of the category name, as `categoryHash` of
 * `@msgboard/sdk` computes it.
 *
 * @param pair The pair name.
 * @param direction The direction of the proof.
 */
export const proofCategory = (pair: string, direction: ProofDirection): Hex =>
  keccak256(stringToBytes(proofCategoryName(pair, direction)));
