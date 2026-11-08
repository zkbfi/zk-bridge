import { describe, expect, it } from "vitest";
import { encodeFunctionData, type Address, type Hex } from "viem";
import { buildMessageId, encodeAmbMessage, tokenMediatorAbi, type ChainLog } from "../src/index.js";
import { assemble, collectNeeds } from "../src/rpc/assemble.js";
import { addressOf, hashOf, testPair } from "./support/fixtures.js";

const pair = testPair();
const [first, second] = pair.sides;
const token = addressOf("aa");

const sendLog = (input: { messageId: Hex; topicId?: Hex; data?: Hex; chain?: "first" | "second" }): ChainLog => {
  const source = input.chain === "second" ? second : first;
  const destination = input.chain === "second" ? first : second;
  const call = encodeFunctionData({ abi: tokenMediatorAbi, functionName: "handleBridgedTokens", args: [token, addressOf("22"), 5n] });
  const encodedData =
    input.data ??
    encodeAmbMessage({
      header: { messageId: input.messageId, sender: addressOf("11"), executor: destination.contracts.mediator, reservedGas: 0, dataType: 0, sourceChainId: BigInt(source.chainId), destinationChainId: BigInt(destination.chainId) },
      data: call,
    });
  return {
    eventName: "UserRequestForAffirmation",
    address: source.contracts.bridge,
    blockNumber: 100n,
    logIndex: 0,
    transactionHash: hashOf("aa"),
    args: { messageId: input.topicId ?? input.messageId, encodedData },
  };
};

const lookups = (logs: ReadonlyMap<number, readonly ChainLog[]>) => ({
  pair,
  logs,
  timestampOf: () => 1_000n,
  latestTimestamp: () => 1_000n,
  readingOf: (_chainId: number, _address: Address) => ({ name: null, symbol: null, decimals: null, nativeBehind: null }),
  executionBlockOf: () => 0n,
  currentHead: () => null,
});

describe("a malformed send log", () => {
  const id = buildMessageId(1n, first.contracts.bridge, 1n);
  const otherId = buildMessageId(1n, first.contracts.bridge, 2n);

  it("is skipped when its data does not decode, so one bad log does not hide the rest of the history", () => {
    const logs = new Map<number, readonly ChainLog[]>([
      [first.chainId, [sendLog({ messageId: id, data: "0x1234" }), sendLog({ messageId: otherId })]],
      [second.chainId, []],
    ]);
    const needs = collectNeeds(pair, logs);
    expect(needs.tokens).toEqual([{ chainId: 1, address: token }]);
    const { messages } = assemble(lookups(logs));
    expect([...messages.keys()]).toEqual([otherId]);
  });

  it("is skipped when the identifier of its topic is not the identifier in its data, because one of them lies", () => {
    const logs = new Map<number, readonly ChainLog[]>([
      [first.chainId, [sendLog({ messageId: id, topicId: otherId })]],
      [second.chainId, []],
    ]);
    expect(collectNeeds(pair, logs).tokens).toEqual([]);
    const { messages, transfers } = assemble(lookups(logs));
    expect(messages.size).toBe(0);
    expect(transfers.size).toBe(0);
  });
});

describe("a send to an arbitrary executor", () => {
  it("is a message with no transfer and names no token", () => {
    const id = buildMessageId(1n, first.contracts.bridge, 3n);
    const data = encodeAmbMessage({
      header: { messageId: id, sender: addressOf("11"), executor: addressOf("33"), reservedGas: 0, dataType: 0, sourceChainId: 1n, destinationChainId: 369n },
      data: "0xabcd",
    });
    const logs = new Map<number, readonly ChainLog[]>([
      [first.chainId, [sendLog({ messageId: id, data })]],
      [second.chainId, []],
    ]);
    expect(collectNeeds(pair, logs).tokens).toEqual([]);
    const { messages, transfers, tokens } = assemble(lookups(logs));
    expect(messages.get(id)).toMatchObject({ kind: "message", sentBlockNumber: 100n });
    expect(transfers.size).toBe(0);
    expect(tokens.size).toBe(0);
  });
});
