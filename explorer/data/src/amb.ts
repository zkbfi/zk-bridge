import { bytesToHex, concatHex, hexToBigInt, hexToBytes, keccak256, pad, toHex, type Address, type Hex } from "viem";
import { normalizeAddress } from "@zkb/core";

/**
 * The Arbitrary Message Bridge message encoding, byte for byte as `AmbMessageCodec.sol` writes it.
 *
 * Layout, in bytes: 32 message identifier, 20 sender, 20 executor, 4 gas limit, 1 length X of the source chain
 * identifier, 1 length Y of the destination chain identifier, 1 data type, X source chain identifier, Y destination
 * chain identifier, then the call data.
 */

/** The data type byte of a message sent with `requireToPassMessage`. */
export const DATA_TYPE_PASS = 0x00;
/** The data type byte of a message sent with `requireToConfirmMessage`. */
export const DATA_TYPE_CONFIRM = 0x80;
/** The format version in the top four bytes of every message identifier. */
export const MESSAGE_PACKING_VERSION = 0x00050000;

const FIXED_HEADER_LENGTH = 79;
const UINT64_MASK = (1n << 64n) - 1n;

/** The fields of a message without its call data. Addresses are lowercase. */
export type AmbHeader = {
  readonly messageId: Hex;
  readonly sender: Address;
  readonly executor: Address;
  readonly gasLimit: number;
  readonly dataType: number;
  readonly sourceChainId: bigint;
  readonly destinationChainId: bigint;
};

/** A decoded message. */
export type AmbMessage = {
  readonly header: AmbHeader;
  /** The call data for the executor, as hex. */
  readonly data: Hex;
};

/**
 * The fewest bytes that hold a chain identifier, 1 to 32. An identifier of zero takes one byte.
 *
 * @param chainId The chain identifier.
 */
export const chainIdLength = (chainId: bigint): number => {
  let length = 1;
  while (length < 32 && chainId >> BigInt(8 * length) !== 0n) length += 1;
  return length;
};

/**
 * Writes a message as `AmbMessageCodec.encode` does.
 *
 * @param message The header and the call data.
 * @returns The encoded message as hex.
 */
export const encodeAmbMessage = (message: AmbMessage): Hex => {
  const { header, data } = message;
  const sourceLength = chainIdLength(header.sourceChainId);
  const destinationLength = chainIdLength(header.destinationChainId);
  return concatHex([
    pad(header.messageId, { size: 32 }),
    header.sender,
    header.executor,
    toHex(header.gasLimit, { size: 4 }),
    toHex(sourceLength, { size: 1 }),
    toHex(destinationLength, { size: 1 }),
    toHex(header.dataType, { size: 1 }),
    toHex(header.sourceChainId, { size: sourceLength }),
    toHex(header.destinationChainId, { size: destinationLength }),
    data,
  ]);
};

/**
 * Reads a message as `AmbMessageCodec.decode` does.
 *
 * @param encoded The encoded message as hex.
 * @throws When the message is shorter than its header says or a chain identifier length is not 1 to 32.
 */
export const decodeAmbMessage = (encoded: Hex): AmbMessage => {
  const bytes = hexToBytes(encoded);
  if (bytes.length < FIXED_HEADER_LENGTH) throw new Error("malformed message: shorter than the fixed header");
  const sourceLength = bytes[76] as number;
  const destinationLength = bytes[77] as number;
  const lengthsValid = [sourceLength, destinationLength].every((length) => length >= 1 && length <= 32);
  if (!lengthsValid) throw new Error("malformed message: chain identifier length out of range");
  const destinationStart = FIXED_HEADER_LENGTH + sourceLength;
  const dataStart = destinationStart + destinationLength;
  if (bytes.length < dataStart) throw new Error("malformed message: shorter than its chain identifiers");
  const slice = (start: number, end: number): Hex => bytesToHex(bytes.subarray(start, end));
  return {
    header: {
      messageId: slice(0, 32),
      sender: normalizeAddress(slice(32, 52)),
      executor: normalizeAddress(slice(52, 72)),
      gasLimit: Number(hexToBigInt(slice(72, 76))),
      dataType: bytes[78] as number,
      sourceChainId: hexToBigInt(slice(FIXED_HEADER_LENGTH, destinationStart)),
      destinationChainId: hexToBigInt(slice(destinationStart, dataStart)),
    },
    data: slice(dataStart, bytes.length),
  };
};

/**
 * The identifier prefix of a bridge: the version and bytes 4 to 23 of `keccak256(chainId, bridge)`. Add the nonce
 * in the low eight bytes to get a message identifier.
 *
 * @param sourceChainId The chain identifier of the sending bridge.
 * @param bridge The address of the sending bridge.
 */
export const messageIdPrefix = (sourceChainId: bigint, bridge: Address): Hex => {
  const hash = hexToBigInt(keccak256(concatHex([toHex(sourceChainId, { size: 32 }), bridge])));
  const bridgePart = hash & (((1n << 160n) - 1n) << 64n);
  const version = BigInt(MESSAGE_PACKING_VERSION) << 224n;
  return toHex(version | bridgePart, { size: 32 });
};

/**
 * Builds a message identifier.
 *
 * @param sourceChainId The chain identifier of the sending bridge.
 * @param bridge The address of the sending bridge.
 * @param nonce The send counter of the bridge.
 */
export const buildMessageId = (sourceChainId: bigint, bridge: Address, nonce: bigint): Hex =>
  toHex(hexToBigInt(messageIdPrefix(sourceChainId, bridge)) | (nonce & UINT64_MASK), { size: 32 });

/**
 * The send counter in the low eight bytes of a message identifier.
 *
 * @param messageId The message identifier.
 */
export const messageNonce = (messageId: Hex): bigint => hexToBigInt(messageId) & UINT64_MASK;

/**
 * Whether the identifier carries the format version that this bridge reads.
 *
 * @param messageId The message identifier.
 */
export const hasValidVersion = (messageId: Hex): boolean => hexToBigInt(messageId) >> 224n === BigInt(MESSAGE_PACKING_VERSION);
