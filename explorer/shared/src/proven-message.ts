/**
 * The message that a call of `executeMessage` delivers, read from its proof.
 *
 * The bridge does not take a message identifier as an argument. It reads the message from a receipt log that the
 * proof proves: the log at `logIndex` of the receipt at `receiptIndex`, under the receipts root of the execution
 * header. The transaction hash is the hash of the transaction at the same index. This module reads the same values
 * the same way, so a page can tell which message a signature delivers without trusting any label next to the
 * calldata. It does not check the beacon part of the proof: the contract does that, and a proof that fails it reverts.
 */
import { bytesToHex, decodeAbiParameters, decodeFunctionData, fromRlp, getAddress, hexToBigInt, hexToBytes, keccak256, size, slice, toRlp, type Address, type Hex } from "viem";
import { messageBridgeAbi } from "./abis/index.js";

/** The fields of a message that the contract reads from the proven log. */
export type ProvenMessage = {
  readonly messageId: Hex;
  readonly sourceTransactionHash: Hex;
  readonly sender: Address;
  readonly executor: Address;
  readonly gasLimit: bigint;
  readonly sourceChainId: bigint;
  readonly destinationChainId: bigint;
};

/** A proof that does not prove a message the way the contract reads one. */
export class ProvenMessageError extends Error {
  override readonly name: string = "ProvenMessageError";
}

// keccak256("UserRequestForAffirmation(bytes32,bytes)"), the topic that the bridge requires (USER_REQUEST_TOPIC).
const USER_REQUEST_TOPIC = keccak256(new TextEncoder().encode("UserRequestForAffirmation(bytes32,bytes)"));
// The indexes of the roots in an execution header, as in BeaconProofVerifier.
const TRANSACTIONS_ROOT_FIELD = 4;
const RECEIPTS_ROOT_FIELD = 5;
// The bytes before the two chain identifiers in an encoded message, as in AmbMessageCodec.
const FIXED_HEADER_LENGTH = 79;

type RlpItem = Hex | readonly RlpItem[];

const fail = (reason: string): never => {
  throw new ProvenMessageError(reason);
};

const nibblesOf = (data: Hex): number[] => [...hexToBytes(data)].flatMap((byte) => [byte >> 4, byte & 0x0f]);

/**
 * Reads the value under a key of a Merkle Patricia trie from a proof, the list of the encoded nodes from the root down.
 * Every node must hash to the reference in its parent, so the value is the one that the root fixes for the key.
 *
 * @param root The root hash of the trie.
 * @param key The key, as bytes.
 * @param proof The encoded nodes.
 */
export const readTrieValue = (root: Hex, key: Hex, proof: readonly Hex[]): Hex => {
  let path = nibblesOf(key);
  let reference: Hex = root;
  let node: RlpItem | null = null;
  let next = 0;
  for (;;) {
    if (node === null) {
      const encoded = proof[next++];
      if (encoded === undefined) return fail("The trie proof ends early.");
      if (keccak256(encoded) !== reference.toLowerCase()) return fail("A trie proof node does not match the hash in its parent.");
      node = fromRlp(encoded, "hex") as RlpItem;
    }
    if (typeof node === "string") return fail("A trie proof node is malformed.");
    let child: RlpItem;
    if (node.length === 17) {
      if (path.length === 0) {
        const value = node[16] as RlpItem;
        if (typeof value !== "string" || value === "0x") return fail("The key is not in the trie.");
        return value;
      }
      child = node[path[0]!] as RlpItem;
      path = path.slice(1);
    } else if (node.length === 2 && typeof node[0] === "string") {
      const compact = nibblesOf(node[0]);
      const flag = compact[0];
      if (flag === undefined) return fail("A trie proof node is malformed.");
      const segment = compact.slice(flag % 2 === 1 ? 1 : 2);
      const matches = segment.length <= path.length && segment.every((nibble, index) => nibble === path[index]);
      if (!matches) return fail("The key is not in the trie.");
      path = path.slice(segment.length);
      if (flag >= 2) {
        if (path.length !== 0 || typeof node[1] !== "string") return fail("The key is not in the trie.");
        return node[1];
      }
      child = node[1] as RlpItem;
    } else {
      return fail("A trie proof node is malformed.");
    }
    if (typeof child !== "string") {
      node = child; // a node shorter than 32 bytes sits inline in its parent
    } else if (child === "0x") {
      return fail("The key is not in the trie.");
    } else if (size(child) !== 32) {
      return fail("A trie proof node is malformed.");
    } else {
      reference = child;
      node = null;
    }
  }
};

const indexKey = (index: bigint): Hex => {
  if (index === 0n) return toRlp("0x");
  const digits = index.toString(16);
  return toRlp(`0x${digits.length % 2 === 1 ? "0" : ""}${digits}`);
};

const listOf = (item: RlpItem, length: number, what: string): readonly RlpItem[] => {
  if (typeof item === "string" || item.length !== length) return fail(`The ${what} is malformed.`);
  return item;
};

const bytesOf = (item: RlpItem | undefined, what: string): Hex => {
  if (typeof item !== "string") return fail(`The ${what} is malformed.`);
  return item;
};

/** The receipt fields, after the type byte of a typed receipt. */
const receiptFields = (receipt: Hex): readonly RlpItem[] => {
  const first = hexToBytes(receipt)[0] ?? fail("The receipt is empty.");
  const payload = first < 0x80 ? slice(receipt, 1) : receipt;
  return listOf(fromRlp(payload, "hex") as RlpItem, 4, "receipt");
};

const word = (data: Uint8Array, start: number, length: number): Hex => bytesToHex(data.subarray(start, start + length));

/** Decodes an encoded message as AmbMessageCodec.decode does. */
const decodeMessage = (encoded: Hex) => {
  const data = hexToBytes(encoded);
  if (data.length < FIXED_HEADER_LENGTH) return fail("The message is malformed.");
  const sourceLength = data[76]!;
  const destinationLength = data[77]!;
  if (sourceLength === 0 || sourceLength > 32 || destinationLength === 0 || destinationLength > 32) return fail("The message is malformed.");
  if (data.length < FIXED_HEADER_LENGTH + sourceLength + destinationLength) return fail("The message is malformed.");
  return {
    messageId: word(data, 0, 32),
    sender: getAddress(word(data, 32, 20)),
    executor: getAddress(word(data, 52, 20)),
    gasLimit: hexToBigInt(word(data, 72, 4)),
    sourceChainId: hexToBigInt(word(data, FIXED_HEADER_LENGTH, sourceLength)),
    destinationChainId: hexToBigInt(word(data, FIXED_HEADER_LENGTH + sourceLength, destinationLength)),
  };
};

/**
 * Reads the message that a call of `executeMessage` delivers when its proof holds.
 *
 * @param calldata The calldata of `executeMessage`.
 */
export const readProvenMessage = (calldata: Hex): ProvenMessage => {
  let decoded;
  try {
    decoded = decodeFunctionData({ abi: messageBridgeAbi, data: calldata });
  } catch {
    return fail("The calldata is not a call to executeMessage.");
  }
  if (decoded.functionName !== "executeMessage") return fail("The calldata is not a call to executeMessage.");
  const proof = decoded.args[0] as {
    executionHeaderRlp: Hex;
    receiptProof: readonly Hex[];
    receiptIndex: bigint;
    transactionProof: readonly Hex[];
    transactionIndex: bigint;
    logIndex: bigint;
  };
  if (proof.receiptIndex !== proof.transactionIndex) return fail("The receipt and the transaction have different indexes.");

  const header = fromRlp(proof.executionHeaderRlp, "hex") as RlpItem;
  if (typeof header === "string") return fail("The execution header is malformed.");
  const transactionsRoot = bytesOf(header[TRANSACTIONS_ROOT_FIELD], "execution header");
  const receiptsRoot = bytesOf(header[RECEIPTS_ROOT_FIELD], "execution header");
  const key = indexKey(proof.receiptIndex);
  const receipt = readTrieValue(receiptsRoot, key, proof.receiptProof);
  const sourceTransactionHash = keccak256(readTrieValue(transactionsRoot, key, proof.transactionProof));

  const [status, , , logs] = receiptFields(receipt);
  if (status !== "0x01") return fail("The receipt is of a failed transaction.");
  if (typeof logs === "string" || proof.logIndex >= BigInt(logs!.length)) return fail("The log index is out of range.");
  const [, topics, eventData] = listOf(logs![Number(proof.logIndex)]!, 3, "log");
  if (typeof topics === "string" || topics!.length !== 2) return fail("The log does not have the topics of a message.");
  if (bytesOf(topics![0], "log").toLowerCase() !== USER_REQUEST_TOPIC) return fail("The log is not a message request.");
  const topicMessageId = bytesOf(topics![1], "log").toLowerCase() as Hex;

  let encoded: Hex;
  try {
    const data = bytesOf(eventData, "log");
    if (size(data) < 64 || hexToBigInt(slice(data, 0, 32)) !== 32n) return fail("The event data is malformed.");
    [encoded] = decodeAbiParameters([{ type: "bytes" }], data);
  } catch (error) {
    if (error instanceof ProvenMessageError) throw error;
    return fail("The event data is malformed.");
  }
  const message = decodeMessage(encoded);
  if (message.messageId !== topicMessageId) return fail("The message identifier differs from the one in the log topic.");
  return { ...message, sourceTransactionHash };
};
