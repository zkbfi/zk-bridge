/**
 * Operator actions: post a light client update, and execute a message from evidence.
 *
 * The functions here are pure and browser safe. They hold no key and read no chain. They turn a prover file or a proof
 * message into a call for a wallet to send. The prover files carry ready calldata, but this code never trusts them as
 * written. It decodes the calldata, and it requires every address and number in the file to agree with the calldata
 * and with the chain list. A file that points at another contract is refused, not corrected.
 */
import {
  decodeFunctionData,
  encodeFunctionData,
  getAddress,
  toFunctionSelector,
  toFunctionSignature,
  type Abi,
  type AbiFunction,
  type Address,
  type Hex,
} from "viem";
import { beaconLightClientAbi, messageBridgeAbi } from "./abis/index.js";
import { describeBytes, displayArguments, type DisplayedArgument } from "./call-display.js";
import { decodeLightClientOutput, type LightClientOutput, type ProofMessage } from "./proof-message.js";
import { readProvenMessage, type ProvenMessage } from "./proven-message.js";

/** A chain that an operator action may target, with the two contracts that the actions call. */
export type OperatorChain = {
  readonly chainId: number;
  readonly name: string;
  readonly lightClient: Address;
  readonly messageBridge: Address;
};

/** One line of the argument list of a call. */
export type OperatorArgument = DisplayedArgument;

/** A call that the operator may send. It has no nonce, gas or value: the wallet adds them. */
export type OperatorCall = {
  readonly title: string;
  readonly chainId: number;
  readonly to: Address;
  readonly functionName: "update" | "executeMessage" | string;
  readonly functionSignature: string;
  readonly data: Hex;
  readonly arguments: readonly OperatorArgument[];
  readonly notes: readonly string[];
};

/** A call in a sequence, with its place in the sequence. */
export type OperatorStep = {
  readonly call: OperatorCall;
  readonly role: "prerequisite" | "execute";
  /** The text of the reason that the prover gave, for a prerequisite. */
  readonly reason: string | null;
};

/** A summary of a message to execute, for the screen that shows the file before any transaction. */
export type EvidenceSummary = {
  readonly route: string;
  readonly messageId: Hex;
  readonly sender: Address;
  readonly executor: Address;
  readonly sourceTransactionHash: Hex;
  readonly sourceSlot: bigint;
  readonly anchorSlot: bigint;
  readonly deliveryStatus: string;
};

/** A prover file is malformed, or it disagrees with its own calldata or with the chain list. */
export class OperatorFileError extends Error {
  override readonly name: string = "OperatorFileError";
}

/** A file names a chain that is not in the chain list. `chainId` is the chain that the file names. */
export class OperatorChainError extends OperatorFileError {
  override readonly name = "OperatorChainError";
  constructor(readonly chainId: number) {
    super(`The file names chain ${chainId}, which is not a chain that this tool is set up for.`);
  }
}

type JsonObject = Record<string, unknown>;

const HANDOFF_SCHEMA_VERSION = 1;
const EVIDENCE_SCHEMA_VERSION = 2;

/**
 * Builds the calldata of `update(proof, publicValues)`. Tests and fixtures use it to write handoff files.
 *
 * @param proof The proof bytes.
 * @param publicValues The public values of the proof.
 */
export const encodeUpdateCalldata = (proof: Hex, publicValues: Hex): Hex =>
  encodeFunctionData({ abi: beaconLightClientAbi, functionName: "update", args: [proof, publicValues] });

/**
 * Reads a prover handoff and plans the light client update.
 *
 * @param text The JSON text of the handoff (`zk-bridge-prover prove` output).
 * @param chains The chains that may be targeted. The destination must be one of them, at its light client.
 * @throws OperatorFileError when the file is malformed or disagrees with its calldata or the chains.
 */
export const planUpdateFromHandoff = (text: string, chains: readonly OperatorChain[]): OperatorCall => {
  const file = readObject(parseJson(text), "handoff");
  requireNumber(file, "schemaVersion", HANDOFF_SCHEMA_VERSION, "handoff");
  const destination = readObject(file.destination, "handoff.destination");
  const chain = chainOf(chains, readSafeInteger(destination, "chainId", "handoff.destination"));
  const lightClient = readAddressField(destination, "lightClient", "handoff.destination");
  requireSameAddress(lightClient, chain.lightClient, `the light client of ${chain.name}`);

  const proof = readHexField(file, "proof", "handoff");
  const publicValues = readHexField(file, "publicValues", "handoff");
  const updateCalldata = readHexField(file, "updateCalldata", "handoff");
  const call = decodeUpdateCalldata(updateCalldata);
  requireEqual(call.proof, proof, "the proof in updateCalldata", "the proof in the file");
  requireEqual(call.publicValues, publicValues, "the public values in updateCalldata", "the public values in the file");

  requireOutputMatches(readLightClientOutput(publicValues), {
    startSlot: readSlot(file, "startHeadSlot", "handoff"),
    startRoot: readHexField(file, "startHeadRoot", "handoff"),
    newSlot: readSlot(file, "newHeadSlot", "handoff"),
    newRoot: readHexField(file, "newHeadRoot", "handoff"),
  });
  return updateCallOf(chain, proof, publicValues, updateCalldata);
};

/**
 * Tells why a proof cannot be posted now, or null when the light client would take it. The contract refuses an update
 * that does not start at its current head (`PreviousHeadSlotMismatch`), so a page reads the head again before it posts.
 *
 * @param proof The proof.
 * @param headSlot The slot that the light client stores now.
 */
export const proofStartProblem = (proof: ProofMessage, headSlot: bigint): string | null => {
  if (proof.newSlot <= headSlot) return `The light client already holds slot ${headSlot}. This proof reaches only slot ${proof.newSlot}.`;
  if (proof.startSlot !== headSlot) return `The light client head is now at slot ${headSlot}, but this proof starts at slot ${proof.startSlot}. Request a new proof.`;
  return null;
};

/**
 * Plans the light client update that a proof message carries.
 *
 * The call is built from the message, so the calldata is never read from outside. The slots and roots of the message
 * must agree with its public values.
 *
 * @param message A decoded proof message.
 * @param chain The chain that holds the light client to update.
 * @throws OperatorFileError when the public values are malformed or disagree with the slots and roots of the message.
 */
export const planUpdateFromProofMessage = (message: ProofMessage, chain: OperatorChain): OperatorCall => {
  requireOutputMatches(readLightClientOutput(message.publicValues), {
    startSlot: message.startSlot,
    startRoot: message.startRoot,
    newSlot: message.newSlot,
    newRoot: message.newRoot,
  });
  return updateCallOf(chain, message.proof, message.publicValues, encodeUpdateCalldata(message.proof, message.publicValues));
};

/**
 * Reads evidence from `zk-bridge-prover evidence` and plans the calls that deliver the message.
 *
 * The prerequisites come first, in the order of the file, then the execution. The calls of one prerequisite
 * function are alternatives, so the caller must let the user skip a step. An already delivered message is refused.
 *
 * @param text The JSON text of the evidence file.
 * @param chains The chains that may be targeted. The destination must be one of them, at its bridge.
 * @throws OperatorFileError when the file is malformed, disagrees with its calldata, or names a delivered message.
 */
export const planMessageExecution = (
  text: string,
  chains: readonly OperatorChain[],
): { summary: EvidenceSummary; steps: readonly OperatorStep[] } => {
  const file = readObject(parseJson(text), "evidence");
  requireNumber(file, "schemaVersion", EVIDENCE_SCHEMA_VERSION, "evidence");
  const destination = readObject(file.destination, "evidence.destination");
  const chain = chainOf(chains, readSafeInteger(destination, "chainId", "evidence.destination"));
  const bridge = readAddressField(destination, "bridge", "evidence.destination");
  requireSameAddress(bridge, chain.messageBridge, `the message bridge of ${chain.name}`);
  requireSameAddress(
    readAddressField(destination, "lightClient", "evidence.destination"),
    chain.lightClient,
    `the light client of ${chain.name}`,
  );

  const deliveryStatus = readString(file, "deliveryStatus", "evidence");
  if (file.alreadyDelivered !== false || deliveryStatus !== "notDelivered") {
    throw new OperatorFileError(`The message is already delivered (status ${deliveryStatus}). It can run only once.`);
  }

  const message = readObject(file.message, "evidence.message");
  const logIndex = readSafeInteger(file, "logIndex", "evidence");
  const execute = readObject(file.execute, "evidence.execute");
  const executeData = readHexField(execute, "data", "evidence.execute");
  requireSameAddress(readAddressField(execute, "to", "evidence.execute"), bridge, "the target of execute");
  const executeCall = decodeExecuteMessage(executeData);
  requireEqual(BigInt(logIndex), executeCall.logIndex, "logIndex in the executeMessage proof", "logIndex in the file");

  // The identity of the message comes from the proof in the calldata, the bytes that the wallet signs. The labels of
  // the file must agree with it, so a file cannot show one message and deliver another.
  const proven = provenMessageOf(executeData);
  if (proven.destinationChainId !== BigInt(chain.chainId)) {
    throw new OperatorFileError(`The proven message is for chain ${proven.destinationChainId}, not for ${chain.name} (${chain.chainId}).`);
  }
  requireEqual(readHexField(message, "messageId", "evidence.message").toLowerCase(), proven.messageId, "messageId in the file", "messageId in the proof");
  requireEqual(readHexField(file, "sourceTransactionHash", "evidence").toLowerCase(), proven.sourceTransactionHash, "sourceTransactionHash in the file", "the transaction hash in the proof");
  requireEqual(readAddressField(message, "sender", "evidence.message"), proven.sender, "sender in the file", "sender in the proof");
  requireEqual(readAddressField(message, "executor", "evidence.message"), proven.executor, "executor in the file", "executor in the proof");

  const anchor = readObject(file.anchor, "evidence.anchor");
  const summary: EvidenceSummary = {
    route: readString(file, "route", "evidence"),
    messageId: proven.messageId,
    sender: proven.sender,
    executor: proven.executor,
    sourceTransactionHash: proven.sourceTransactionHash,
    sourceSlot: readSlot(message, "sourceSlot", "evidence.message"),
    anchorSlot: readSlot(anchor, "slot", "evidence.anchor"),
    deliveryStatus,
  };

  const prerequisites = readArray(file.prerequisites, "evidence.prerequisites").map((entry, index) =>
    prerequisiteStep(readObject(entry, `evidence.prerequisites[${index}]`), { chain, index }),
  );
  const executeStep: OperatorStep = {
    role: "execute",
    reason: null,
    call: {
      title: `Execute message ${summary.messageId.slice(0, 12)}… on ${chain.name}`,
      chainId: chain.chainId,
      to: chain.messageBridge,
      functionName: "executeMessage",
      functionSignature: executeCall.signature,
      data: executeData,
      arguments: [
        { name: "message.messageId", type: "bytes32", value: summary.messageId },
        { name: "message.sender", type: "address", value: summary.sender },
        { name: "message.executor", type: "address", value: summary.executor },
        { name: "sourceTransactionHash", type: "bytes32", value: summary.sourceTransactionHash },
        ...executeCall.arguments,
      ],
      notes: [
        "The bridge checks the evidence itself. No proof is needed.",
        `The target ${summary.executor} receives the call with all the gas that is left. If the call fails or the gas runs out, the whole delivery reverts and the message stays undelivered, so anyone can send it again.`,
      ],
    },
  };
  return { summary, steps: [...prerequisites, executeStep] };
};

const updateCallOf = (chain: OperatorChain, proof: Hex, publicValues: Hex, data: Hex): OperatorCall => {
  const output = decodeLightClientOutput(publicValues);
  return {
    title: `Post a light client update to ${chain.name}`,
    chainId: chain.chainId,
    to: chain.lightClient,
    functionName: "update",
    functionSignature: "update(bytes,bytes)",
    data,
    arguments: [
      bytesArgumentOf("proof", proof),
      bytesArgumentOf("publicValues", publicValues),
      { name: "publicValues.previousHeadSlot", type: "uint64", value: output.previousHeadSlot.toString() },
      { name: "publicValues.newHeadSlot", type: "uint64", value: output.newHeadSlot.toString() },
      { name: "publicValues.newHeaderRoot", type: "bytes32", value: output.newHeaderRoot },
      { name: "publicValues.executionBlockNumber", type: "uint64", value: output.executionBlockNumber.toString() },
    ],
    notes: [
      `The light client moves from slot ${output.previousHeadSlot} to slot ${output.newHeadSlot}.`,
      "The contract refuses the update when its stored head is no longer the start head.",
    ],
  };
};

const LAYOUT_FUNCTIONS: ReadonlySet<string> = new Set(["addBlockRootsLayout", "addBlockHashLayout", "addHistoricalSummariesLayout"]);

const prerequisiteStep = (entry: JsonObject, context: { chain: OperatorChain; index: number }): OperatorStep => {
  const where = `evidence.prerequisites[${context.index}]`;
  requireSameAddress(
    readAddressField(entry, "to", where),
    context.chain.messageBridge,
    `the target of prerequisite ${context.index}`,
  );
  const data = readHexField(entry, "data", where);
  const decoded = decodeBridgeCall(data);
  if (decoded === null) {
    throw new OperatorFileError(
      `Prerequisite ${context.index} is not a known message bridge call (selector ${data.slice(0, 10)}).`,
    );
  }
  requireEqual(decoded.functionName, readString(entry, "function", where), "the function in the calldata", "the function named in the file");
  // Only the three layout functions may come before the execution. Any other bridge call, such as a send or the
  // execution of another message, would run from the user's wallet under the title of a layout row.
  if (!LAYOUT_FUNCTIONS.has(decoded.functionName)) {
    throw new OperatorFileError(
      `Prerequisite ${context.index} calls ${decoded.functionName}, which does not add a layout row.`,
    );
  }
  return {
    role: "prerequisite",
    reason: readString(entry, "reason", where),
    call: {
      title: `Add a layout row: ${decoded.functionName}`,
      chainId: context.chain.chainId,
      to: context.chain.messageBridge,
      functionName: decoded.functionName,
      functionSignature: decoded.functionSignature,
      data,
      arguments: decoded.arguments,
      notes: ["The bridge needs a validated layout row before it can check the evidence. The chain validates the row."],
    },
  };
};

const decodeUpdateCalldata = (data: Hex): { proof: Hex; publicValues: Hex } => {
  try {
    const decoded = decodeFunctionData({ abi: beaconLightClientAbi, data });
    if (decoded.functionName !== "update") throw new Error("not update");
    const [proof, publicValues] = decoded.args as readonly [Hex, Hex];
    return { proof, publicValues };
  } catch {
    throw new OperatorFileError("updateCalldata is not a call to update(bytes,bytes).");
  }
};

/** Reads the public values with the shared decoder, and reports a bad file as an {@link OperatorFileError}. */
const readLightClientOutput = (publicValues: Hex): LightClientOutput => {
  try {
    return decodeLightClientOutput(publicValues);
  } catch (error) {
    throw new OperatorFileError(`The public values are not a light client output: ${(error as Error).message}.`);
  }
};

const requireOutputMatches = (
  output: LightClientOutput,
  expected: { startSlot: bigint; startRoot: Hex; newSlot: bigint; newRoot: Hex },
): void => {
  requireEqual(output.previousHeadSlot, expected.startSlot, "previousHeadSlot in the public values", "startHeadSlot");
  requireEqual(output.newHeadSlot, expected.newSlot, "newHeadSlot in the public values", "newHeadSlot");
  requireEqual(output.previousHeaderRoot, expected.startRoot, "previousHeaderRoot in the public values", "startHeadRoot");
  requireEqual(output.newHeaderRoot, expected.newRoot, "newHeaderRoot in the public values", "newHeadRoot");
};

const provenMessageOf = (data: Hex): ProvenMessage => {
  try {
    return readProvenMessage(data);
  } catch (error) {
    // A malformed encoding throws from viem, a refused part throws a ProvenMessageError: either way the file is bad.
    throw new OperatorFileError(`The executeMessage proof does not prove a message: ${(error as Error).message}`);
  }
};

const decodeExecuteMessage = (data: Hex) => {
  const decoded = decodeBridgeCall(data);
  if (decoded === null || decoded.functionName !== "executeMessage") {
    throw new OperatorFileError("execute.data is not a call to executeMessage.");
  }
  const proof = decodeFunctionData({ abi: messageBridgeAbi, data }).args?.[0] as { logIndex: bigint };
  return { signature: decoded.functionSignature, arguments: decoded.arguments, logIndex: proof.logIndex };
};

/** Decodes calldata against the message bridge ABI. Returns `null` for an unknown selector or arguments that fail. */
const decodeBridgeCall = (
  data: Hex,
): { functionName: string; functionSignature: string; arguments: readonly OperatorArgument[] } | null => {
  const abi: Abi = messageBridgeAbi;
  const selector = data.slice(0, 10);
  const item = abi.find(
    (entry): entry is AbiFunction => entry.type === "function" && toFunctionSelector(entry) === selector,
  );
  if (item === undefined) return null;
  try {
    const decoded = decodeFunctionData({ abi, data });
    return {
      functionName: item.name,
      functionSignature: toFunctionSignature(item),
      arguments: displayArguments(item.inputs, decoded.args as readonly unknown[]),
    };
  } catch {
    return null;
  }
};

const bytesArgumentOf = (name: string, value: Hex): OperatorArgument => ({ name, type: "bytes", ...describeBytes(value) });

const chainOf = (chains: readonly OperatorChain[], chainId: number): OperatorChain => {
  const chain = chains.find((candidate) => candidate.chainId === chainId);
  if (chain === undefined) {
    throw new OperatorChainError(chainId);
  }
  return chain;
};

const requireSameAddress = (found: Address, expected: Address, what: string): void => {
  if (found.toLowerCase() === expected.toLowerCase()) return;
  throw new OperatorFileError(`The file names ${abbreviate(found)} for ${what}; the deployment says ${abbreviate(expected)}.`);
};

const requireEqual = <Value extends bigint | string>(
  left: Value,
  right: Value,
  leftName: string,
  rightName: string,
): void => {
  if (left === right) return;
  throw new OperatorFileError(`${leftName} (${abbreviate(left)}) differs from ${rightName} (${abbreviate(right)}).`);
};

/** Cuts long values, such as proofs, so an error message stays one readable line. */
const abbreviate = (value: bigint | string): string => {
  const text = value.toString();
  return text.length <= 24 ? text : `${text.slice(0, 12)}…${text.slice(-8)}`;
};

const requireNumber = (source: JsonObject, key: string, expected: number, where: string): void => {
  if (source[key] === expected) return;
  throw new OperatorFileError(`${where}.${key} must be ${expected}, found ${JSON.stringify(source[key])}.`);
};

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    throw new OperatorFileError("The file is not valid JSON.");
  }
};

const readObject = (value: unknown, where: string): JsonObject => {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as JsonObject;
  throw new OperatorFileError(`${where} must be an object.`);
};

const readArray = (value: unknown, where: string): unknown[] => {
  if (Array.isArray(value)) return value;
  throw new OperatorFileError(`${where} must be an array.`);
};

const readString = (source: JsonObject, key: string, where: string): string => {
  const value = source[key];
  if (typeof value === "string") return value;
  throw new OperatorFileError(`${where}.${key} must be a string.`);
};

const readSafeInteger = (source: JsonObject, key: string, where: string): number => {
  const value = source[key];
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  throw new OperatorFileError(`${where}.${key} must be a non-negative integer.`);
};

const readSlot = (source: JsonObject, key: string, where: string): bigint => BigInt(readSafeInteger(source, key, where));

const readHexField = (source: JsonObject, key: string, where: string): Hex => {
  const value = readString(source, key, where);
  if (/^0x([0-9a-fA-F]{2})*$/.test(value)) return value.toLowerCase() as Hex;
  throw new OperatorFileError(`${where}.${key} must be 0x hex with whole bytes.`);
};

const readAddressField = (source: JsonObject, key: string, where: string): Address => {
  const value = readString(source, key, where);
  if (/^0x[0-9a-fA-F]{40}$/.test(value)) return getAddress(value);
  throw new OperatorFileError(`${where}.${key} must be an address.`);
};
