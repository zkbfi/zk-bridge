import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildMessageId,
  chainIdLength,
  decodeAmbMessage,
  encodeAmbMessage,
  hasValidVersion,
  messageIdPrefix,
  messageNonce,
} from "../src/amb.js";
import { decodeMediatorMessage } from "../src/mediator-message.js";
import type { Address, Hex } from "viem";

type MessageVector = {
  kind: "message";
  sourceChainId: string;
  destinationChainId: string;
  bridge: Address;
  nonce: string;
  messageId: Hex;
  sender: Address;
  executor: Address;
  gasLimit: number;
  dataType: number;
  data: Hex;
  encoded: Hex;
};
type MediatorVector = { kind: "mediator"; handler: string; data: Hex };

// Vectors written by explorer/shared/vectors/GenerateAmbVectors.s.sol, which calls AmbMessageCodec.sol itself.
const vectors = readFileSync(new URL("./fixtures/amb-vectors.jsonl", import.meta.url), "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line) as MessageVector | MediatorVector);
const messageVectors = vectors.filter((vector): vector is MessageVector => vector.kind === "message");
const mediatorVectors = vectors.filter((vector): vector is MediatorVector => vector.kind === "mediator");

describe("AMB message codec against vectors from AmbMessageCodec.sol", () => {
  it("has vectors to test with", () => {
    expect(messageVectors.length).toBeGreaterThanOrEqual(6);
    expect(mediatorVectors.length).toBeGreaterThanOrEqual(5);
  });

  it.each(messageVectors.map((vector, index) => [index, vector] as const))("decodes vector %i field by field", (_, vector) => {
    const { header, data } = decodeAmbMessage(vector.encoded);
    expect(header.messageId).toBe(vector.messageId);
    expect(header.sender).toBe(vector.sender.toLowerCase());
    expect(header.executor).toBe(vector.executor.toLowerCase());
    expect(header.gasLimit).toBe(vector.gasLimit);
    expect(header.dataType).toBe(vector.dataType);
    expect(header.sourceChainId).toBe(BigInt(vector.sourceChainId));
    expect(header.destinationChainId).toBe(BigInt(vector.destinationChainId));
    expect(data).toBe(vector.data);
  });

  it.each(messageVectors.map((vector, index) => [index, vector] as const))("encodes vector %i to the same bytes as Solidity", (_, vector) => {
    const { header, data } = decodeAmbMessage(vector.encoded);
    expect(encodeAmbMessage({ header, data })).toBe(vector.encoded);
  });

  it.each(messageVectors.map((vector, index) => [index, vector] as const))("rebuilds the identifier of vector %i", (_, vector) => {
    const prefix = messageIdPrefix(BigInt(vector.sourceChainId), vector.bridge);
    expect(buildMessageId(BigInt(vector.sourceChainId), vector.bridge, BigInt(vector.nonce))).toBe(vector.messageId);
    expect(prefix.slice(0, 10)).toBe("0x00050000");
    expect(messageNonce(vector.messageId)).toBe(BigInt(vector.nonce));
    expect(hasValidVersion(vector.messageId)).toBe(true);
  });

  it("uses one byte for chain 1 and two bytes for chain 369, as the bridge does", () => {
    expect(chainIdLength(1n)).toBe(1);
    expect(chainIdLength(0n)).toBe(1);
    expect(chainIdLength(255n)).toBe(1);
    expect(chainIdLength(256n)).toBe(2);
    expect(chainIdLength(369n)).toBe(2);
    expect(chainIdLength((1n << 256n) - 1n)).toBe(32);
  });

  it("refuses a message shorter than its fixed header", () => {
    expect(() => decodeAmbMessage("0x0005")).toThrow(/shorter than the fixed header/);
  });

  it("refuses a chain identifier length of zero", () => {
    const first = messageVectors[0] as MessageVector;
    const bytes = first.encoded.slice(2).split("");
    bytes.splice(76 * 2, 2, "0", "0");
    expect(() => decodeAmbMessage(`0x${bytes.join("")}`)).toThrow(/length out of range/);
  });

  it("refuses a message that is cut inside its chain identifiers", () => {
    const first = messageVectors[0] as MessageVector;
    expect(() => decodeAmbMessage(first.encoded.slice(0, 2 + 79 * 2) as Hex)).toThrow(/shorter than its chain identifiers/);
  });

  it("distinguishes bridges: the same nonce on another bridge gives another identifier", () => {
    const one = buildMessageId(1n, "0x1111111111111111111111111111111111111111", 0n);
    const two = buildMessageId(1n, "0x2222222222222222222222222222222222222222", 0n);
    expect(one).not.toBe(two);
  });
});

describe("mediator payloads against vectors from TokenMediator.sol selectors", () => {
  const byHandler = (name: string) => (mediatorVectors.find((vector) => vector.handler === name) as MediatorVector).data;

  it("decodes a plain native release with the recipient as fallback", () => {
    const decoded = decodeMediatorMessage(byHandler("handleNativeTokens"));
    expect(decoded?.releasesNativeToken).toBe(true);
    expect(decoded?.value).toBe(5n * 10n ** 18n);
    expect(decoded?.recipient).toBe("0x90f79bf6eb2c4f870365e785982e1f101e93b906");
    expect(decoded?.fallbackRecipient).toBe(decoded?.recipient);
    expect(decoded?.callbackData).toBeNull();
  });

  it("decodes a bridged release with an explicit fallback", () => {
    const decoded = decodeMediatorMessage(byHandler("handleBridgedTokensWithFallback"));
    expect(decoded?.releasesNativeToken).toBe(false);
    expect(decoded?.value).toBe(123n);
    expect(decoded?.fallbackRecipient).toBe("0x15d34aaf54267db7d7c367839aaf71a00a2c6a65");
  });

  it("decodes callback data", () => {
    const decoded = decodeMediatorMessage(byHandler("handleNativeTokensAndCallWithFallback"));
    expect(decoded?.callbackData).toBe("0xc0ffee");
    expect(decoded?.value).toBe(99n);
  });

  it("decodes the metadata of a deploying message", () => {
    const decoded = decodeMediatorMessage(byHandler("deployAndHandleBridgedTokens"));
    expect(decoded?.deploysCopy).toBe(true);
    expect(decoded?.metadata).toEqual({ name: "Tether USD", symbol: "USDT", decimals: 6 });
    const withCall = decodeMediatorMessage(byHandler("deployAndHandleBridgedTokensAndCallWithFallback"));
    expect(withCall?.metadata).toEqual({ name: "Wrapped Ether", symbol: "WETH", decimals: 18 });
    expect(withCall?.callbackData).toBe("0xaabb");
    expect(withCall?.value).toBe(7n);
  });

  it("returns null for an arbitrary message", () => {
    expect(decodeMediatorMessage("0xdeadbeef")).toBeNull();
    expect(decodeMediatorMessage("0x")).toBeNull();
  });
});
