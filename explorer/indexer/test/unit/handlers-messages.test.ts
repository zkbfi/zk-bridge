import { beforeAll, describe, expect, it } from "vitest";
import { encodeFunctionData } from "viem";
import { buildMessageId, encodeAmbMessage, tokenMediatorAbi } from "@zk-bridge/shared";
import { bridgeStates, deliveryCosts, messages, transactionCosts, transfers } from "../../ponder.schema";
import { AFFIRMATION_COMPLETED_SELECTOR } from "@zk-bridge/shared";
import { callHandler } from "./support/fake-registry";
import {
  BRIDGE_ON_ETHEREUM,
  BRIDGE_ON_PULSECHAIN,
  MEDIATOR_ON_PULSECHAIN,
  addressOf,
  createContext,
  createEvent,
  hashOf,
} from "./support/handler-fixtures";

beforeAll(async () => {
  await import("../../src/handlers/messages");
});

const messageId = buildMessageId(1n, BRIDGE_ON_ETHEREUM, 3n);
const sender = addressOf("11");
const recipient = addressOf("22");
const token = addressOf("33");

const send = (executor: string, data: `0x${string}`, id = messageId) =>
  encodeAmbMessage({
    header: { messageId: id, sender, executor: executor as `0x${string}`, reservedGas: 0, dataType: 0, sourceChainId: 1n, destinationChainId: 369n },
    data,
  });

const handlerCall = (functionName: "handleNativeTokens" | "handleBridgedTokens") =>
  encodeFunctionData({ abi: tokenMediatorAbi, functionName, args: [token, recipient, 42n] });

describe("MessageBridge:UserRequestForAffirmation", () => {
  const name = "MessageBridge:UserRequestForAffirmation";

  it("records a send to the remote mediator as a token message and writes the source side of the transfer", async () => {
    const { database, context } = createContext(1);
    const encodedData = send(MEDIATOR_ON_PULSECHAIN, handlerCall("handleBridgedTokens"));
    await callHandler(name, { event: createEvent({ messageId, encodedData }), context });
    expect(database.row(messages, { messageId })).toMatchObject({
      kind: "token",
      status: "sent",
      sender,
      executor: MEDIATOR_ON_PULSECHAIN,
      sourceChainId: 1,
      destinationChainId: 369,
      sentTransactionHash: hashOf("aa"),
      sentBlockNumber: 100n,
      sentTimestamp: 1_000n,
    });
    // The send's cost is stored with no dollars: the unit tests give no PulseChain access for an Ethereum price.
    expect(database.rows(transactionCosts)).toEqual([expect.objectContaining({ chainId: 1, transactionHash: hashOf("aa"), costWei: 63_000n, costUsd: null })]);
    expect(database.row(transfers, { messageId })).toMatchObject({
      sourceChainId: 1,
      destinationChainId: 369,
      recipient,
      value: 42n,
      handler: "handleBridgedTokens",
      deploysCopy: false,
      hasCallback: false,
      sourceIsNative: true,
      sentTimestamp: 1_000n,
      sourceToken: token,
      destinationToken: null,
    });
  });

  it("stores the log index of the UserRequestForAffirmation log", async () => {
    const { database, context } = createContext(1);
    const encodedData = send(MEDIATOR_ON_PULSECHAIN, handlerCall("handleBridgedTokens"));
    const event = createEvent({ messageId, encodedData }, { log: { address: addressOf("c0"), logIndex: 7 } });
    await callHandler(name, { event, context });
    expect(database.row(messages, { messageId })?.sentLogIndex).toBe(7);
  });

  it("names the token as the destination token when the destination releases a native token", async () => {
    const { database, context } = createContext(1);
    const encodedData = send(MEDIATOR_ON_PULSECHAIN, handlerCall("handleNativeTokens"));
    await callHandler(name, { event: createEvent({ messageId, encodedData }), context });
    expect(database.row(transfers, { messageId })).toMatchObject({ sourceIsNative: false, destinationToken: token, sourceToken: null });
  });

  it("marks a transfer that carries callback data", async () => {
    const { database, context } = createContext(1);
    const data = encodeFunctionData({
      abi: tokenMediatorAbi,
      functionName: "handleBridgedTokensAndCall",
      args: [token, recipient, 42n, "0xc0ffee", 400_000n],
    });
    await callHandler(name, { event: createEvent({ messageId, encodedData: send(MEDIATOR_ON_PULSECHAIN, data) }), context });
    expect(database.row(transfers, { messageId })).toMatchObject({ hasCallback: true, handler: "handleBridgedTokensAndCall" });
  });

  it("records an arbitrary message with no transfer row", async () => {
    const { database, context } = createContext(1);
    await callHandler(name, { event: createEvent({ messageId, encodedData: send(addressOf("99"), "0x1234") }), context });
    expect(database.row(messages, { messageId })).toMatchObject({ kind: "message", data: "0x1234" });
    expect(database.rows(transfers)).toEqual([]);
  });

  it("refuses an event whose topic and data name two identifiers, and writes nothing", async () => {
    const { database, context } = createContext(1);
    const encodedData = send(addressOf("99"), "0x");
    const otherId = buildMessageId(1n, BRIDGE_ON_ETHEREUM, 4n);
    await expect(callHandler(name, { event: createEvent({ messageId: otherId, encodedData }), context })).rejects.toThrow(
      `message identifier mismatch in ${hashOf("aa")}: topic and data disagree`,
    );
    expect(database.writes).toEqual([]);
  });
});

describe("MessageBridge:AffirmationCompleted", () => {
  const name = "MessageBridge:AffirmationCompleted";
  const args = { messageId, status: true };
  const completed = { address: BRIDGE_ON_PULSECHAIN, topics: [AFFIRMATION_COMPLETED_SELECTOR] };

  const deliver = async (logs: unknown[], overrides: Record<string, unknown> = {}) => {
    const fixture = createContext(369);
    fixture.client.getTransactionReceipt.mockResolvedValue({ logs });
    await callHandler(name, { event: createEvent(args, overrides), context: fixture.context });
    return fixture;
  };

  it("records the delivery on the message, with the other chain as the source", async () => {
    const { database } = await deliver([completed]);
    expect(database.row(messages, { messageId })).toMatchObject({
      sourceChainId: 1,
      destinationChainId: 369,
      status: "delivered",
      deliveredTransactionHash: hashOf("aa"),
      deliveredBlockNumber: 100n,
      deliveredTimestamp: 1_000n,
      executedBy: addressOf("f0"),
    });
    expect(database.rows(transactionCosts)).toEqual([expect.objectContaining({ chainId: 369, transactionHash: hashOf("aa"), costWei: 63_000n })]);
  });

  it("reads the receipt of the transaction and stores the gas of a single delivery", async () => {
    const { database, client } = await deliver([completed]);
    expect(client.getTransactionReceipt).toHaveBeenCalledWith({ hash: hashOf("aa") });
    expect(database.row(deliveryCosts, { messageId })).toEqual({
      messageId,
      destinationChainId: 369,
      transactionHash: hashOf("aa"),
      blockNumber: 100n,
      timestamp: 1_000n,
      gasUsed: 21_000n,
      effectiveGasPrice: 3n,
    });
  });

  it("stores no cost for a batch, because the gas of one transaction cannot be split", async () => {
    const { database } = await deliver([completed, completed]);
    expect(database.rows(deliveryCosts)).toEqual([]);
    expect(database.row(messages, { messageId })).toMatchObject({ status: "delivered" });
  });

  it("ignores a delivery log of another contract when it counts deliveries", async () => {
    const { database } = await deliver([completed, { address: addressOf("99"), topics: [AFFIRMATION_COMPLETED_SELECTOR] }]);
    expect(database.rows(deliveryCosts)).toHaveLength(1);
  });

  it("replaces the cost row when the same event runs again", async () => {
    const fixture = await deliver([completed]);
    await callHandler(name, {
      event: createEvent(args, { transactionReceipt: { gasUsed: 30_000n, effectiveGasPrice: 4n } }),
      context: fixture.context,
    });
    expect(fixture.database.rows(deliveryCosts)).toEqual([expect.objectContaining({ gasUsed: 30_000n, effectiveGasPrice: 4n })]);
  });
});

describe("MessageBridge:DepositsOpened", () => {
  it("stores that the bridge on this chain is open, with the slot, the block and the time", async () => {
    const { database, context } = createContext(369);
    await callHandler("MessageBridge:DepositsOpened", { event: createEvent({ remoteSlot: 9n }), context });
    expect(database.rows(bridgeStates)).toEqual([
      { chainId: 369, depositsOpen: true, openedRemoteSlot: 9n, openedBlockNumber: 100n, openedTimestamp: 1_000n },
    ]);
  });

  it("replaces the row when the bridge opens again", async () => {
    const { database, context } = createContext(369);
    await callHandler("MessageBridge:DepositsOpened", { event: createEvent({ remoteSlot: 9n }), context });
    await callHandler("MessageBridge:DepositsOpened", { event: createEvent({ remoteSlot: 12n }), context });
    expect(database.rows(bridgeStates)).toEqual([expect.objectContaining({ openedRemoteSlot: 12n })]);
  });
});
