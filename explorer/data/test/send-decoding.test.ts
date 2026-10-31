import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeFunctionData, type Address } from "viem";
import { buildMessageId, encodeAmbMessage, loadPair, tokenMediatorAbi } from "../src/index.js";
import { decodeSend } from "../src/send-decoding.js";

const section = (chainId: number, digit: string) => ({
  chain_id: chainId,
  rpc_url: "http://127.0.0.1:1",
  bridge: `0x${digit.repeat(40)}`,
  mediator: `0x${String(Number(digit) + 2).repeat(40)}`,
  token_factory: `0x${digit.repeat(40)}`,
  wrapped_native: `0x${digit.repeat(40)}`,
  gate: `0x${digit.repeat(40)}`,
  light_client: `0x${digit.repeat(40)}`,
  start_block: 0,
});
const pair = loadPair({ environment: {}, deployment: { a: section(1, "1"), b: section(369, "2") } });
const mediatorOnPulse = pair.sides[1].contracts.mediator;
const sender: Address = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";

const message = (executor: Address, data: `0x${string}`, overrides: { sourceChainId?: bigint; destinationChainId?: bigint } = {}) =>
  encodeAmbMessage({
    header: {
      messageId: buildMessageId(1n, pair.sides[0].contracts.bridge, 3n),
      sender,
      executor,
      gasLimit: 250_000,
      dataType: 0,
      sourceChainId: overrides.sourceChainId ?? 1n,
      destinationChainId: overrides.destinationChainId ?? 369n,
    },
    data,
  });

describe("decodeSend", () => {
  it("recognizes a token transfer: executor is the remote mediator and the data is a handler call", () => {
    const data = encodeFunctionData({
      abi: tokenMediatorAbi,
      functionName: "handleNativeTokens",
      args: ["0x4444444444444444444444444444444444444444", "0x5555555555555555555555555555555555555555", 42n],
    });
    const decoded = decodeSend(pair, 1, message(mediatorOnPulse, data));
    expect(decoded.messageFacts.kind).toBe("token");
    expect(decoded.transfer?.value).toBe(42n);
    expect(decoded.destinationChainId).toBe(369);
  });

  it("treats a call to another contract as an arbitrary message even if the data looks like a handler call", () => {
    const data = encodeFunctionData({
      abi: tokenMediatorAbi,
      functionName: "handleNativeTokens",
      args: ["0x4444444444444444444444444444444444444444", "0x5555555555555555555555555555555555555555", 42n],
    });
    const decoded = decodeSend(pair, 1, message("0x9999999999999999999999999999999999999999", data));
    expect(decoded.messageFacts.kind).toBe("message");
    expect(decoded.transfer).toBeNull();
  });

  it("treats other data to the mediator as an arbitrary message", () => {
    const data = encodeAbiParameters([{ type: "uint256" }], [1n]);
    expect(decodeSend(pair, 1, message(mediatorOnPulse, data)).transfer).toBeNull();
  });

  it("refuses a message that does not start on the emitting chain or does not go to the other side", () => {
    expect(() => decodeSend(pair, 1, message(mediatorOnPulse, "0x", { sourceChainId: 5n }))).toThrow(/starts on chain/);
    expect(() => decodeSend(pair, 1, message(mediatorOnPulse, "0x", { destinationChainId: 5n }))).toThrow(/goes to chain/);
  });
});
