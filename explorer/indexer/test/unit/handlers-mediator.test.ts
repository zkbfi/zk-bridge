import { beforeAll, describe, expect, it } from "vitest";
import {
  bridgedSupply,
  escrow,
  messages,
  releaseEvents,
  tokens,
  transfers,
} from "../../ponder.schema";
import { callHandler } from "./support/fake-registry";
import type { ReadCall } from "./support/fake-client";
import { MEDIATOR_ON_ETHEREUM, MEDIATOR_ON_PULSECHAIN, addressOf, createContext, createEvent, hashOf, sentMessageRow } from "./support/handler-fixtures";

beforeAll(async () => {
  await import("../../src/handlers/mediator");
});

const ZERO = "0x0000000000000000000000000000000000000000";
const messageId = hashOf("ab");
const token = addressOf("33");
const native = addressOf("44");
const account = addressOf("55");
const other = addressOf("66");

/** Answers the reads of the handlers: the token metadata, the escrow and the native token behind a token. */
const answers =
  (behind: string = ZERO) =>
  ({ functionName }: ReadCall) => {
    const values: Record<string, unknown> = {
      name: "Tether",
      symbol: "USDT",
      decimals: 6,
      nativeTokenAddress: behind,
      mediatorBalance: 500n,
    };
    return values[functionName];
  };

const escrowRow = (chainId: number, tokenAddress: string, blockNumber = 100n) => ({
  chainId,
  token: tokenAddress,
  balance: 500n,
  updatedBlockNumber: blockNumber,
  updatedTimestamp: 1_000n,
});

describe("TokenMediator:TokensBridgingInitiated", () => {
  const name = "TokenMediator:TokensBridgingInitiated";
  const args = { token, sender: account, value: 42n, messageId };

  it("records a lock of a native token: the token row, the source side of the transfer and the escrow", async () => {
    const { database, context } = createContext(1, answers());
    await callHandler(name, { event: createEvent(args), context });
    expect(database.row(tokens, { chainId: 1, address: token })).toMatchObject({
      name: "Tether",
      symbol: "USDT",
      decimals: 6,
      metadataRead: true,
      isBridgedCopy: false,
      homeChainId: 1,
      homeToken: token,
    });
    expect(database.row(transfers, { messageId })).toMatchObject({
      sourceChainId: 1,
      destinationChainId: 369,
      sourceToken: token,
      sender: account,
      value: 42n,
      sourceIsNative: true,
      sentTimestamp: 1_000n,
    });
    expect(database.row(escrow, { chainId: 1, token })).toEqual(escrowRow(1, token));
  });

  it("records a burn of a bridged copy with its home on the other chain, and no escrow", async () => {
    const { database, context } = createContext(369, answers(native));
    await callHandler(name, { event: createEvent(args), context });
    expect(database.row(tokens, { chainId: 369, address: token })).toMatchObject({ isBridgedCopy: true, homeChainId: 1, homeToken: native });
    expect(database.row(transfers, { messageId })).toMatchObject({ sourceChainId: 369, destinationChainId: 1, sourceIsNative: false });
    expect(database.rows(escrow)).toEqual([]);
  });
});

describe("TokenMediator:TokensBridged", () => {
  it("records the payment on the transfer, with the other chain as the source, and refreshes the escrow", async () => {
    const { database, context } = createContext(369, answers());
    await callHandler("TokenMediator:TokensBridged", { event: createEvent({ token, recipient: account, value: 41n, messageId }), context });
    expect(database.row(transfers, { messageId })).toMatchObject({
      sourceChainId: 1,
      destinationChainId: 369,
      destinationToken: token,
      paidTo: account,
      deliveredValue: 41n,
    });
    expect(database.row(escrow, { chainId: 369, token })).toEqual(escrowRow(369, token));
  });
});

describe("TokenMediator:TokensBridged to a delivery router", () => {
  const ROUTER = "0x00000000000000000000000000000000000000e7";
  const OLD_ROUTER = "0x00000000000000000000000000000000000000e8";
  const REWARD = addressOf("77");
  const RECIPIENT = addressOf("88");
  const BRIDGE = "0x00000000000000000000000000000000000000b2";
  const word = (value: bigint) => `0x${value.toString(16).padStart(64, "0")}` as `0x${string}`;
  const topic = (address: string) => `0x${address.slice(2).padStart(64, "0")}` as `0x${string}`;
  const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const transferLog = (logIndex: number, from: string, to: string, value: bigint) => ({ address: token, topics: [TRANSFER, topic(from), topic(to)], data: word(value), logIndex });
  const bridgedLog = { address: MEDIATOR_ON_PULSECHAIN, topics: ["0x01"], data: "0x", logIndex: 1 };
  const routerAnswers = (call: ReadCall) => (call.functionName === "rewardAddress" ? REWARD : answers()(call));

  it("records the fee and what the recipient received from the transfer logs of a router without the event", async () => {
    const { database, client, context } = createContext(369, routerAnswers);
    client.getTransactionReceipt.mockResolvedValue({
      logs: [transferLog(0, ZERO, OLD_ROUTER, 12_300n), bridgedLog, transferLog(2, OLD_ROUTER, REWARD, 12n), transferLog(3, OLD_ROUTER, RECIPIENT, 12_288n)],
    });
    const event = createEvent(
      { token, recipient: OLD_ROUTER, value: 12_300n, messageId },
      { transaction: { hash: hashOf("aa"), from: addressOf("f0"), to: OLD_ROUTER }, log: { address: MEDIATOR_ON_PULSECHAIN, logIndex: 1 } },
    );
    await callHandler("TokenMediator:TokensBridged", { event, context });
    expect(database.row(transfers, { messageId })).toMatchObject({
      paidTo: OLD_ROUTER,
      deliveredValue: 12_300n,
      deliveryRouter: OLD_ROUTER,
      routerAmount: 12_300n,
      fee: 12n,
      received: 12_288n,
      deliverer: REWARD,
      finalRecipient: RECIPIENT,
      feeSource: "logs",
    });
    expect(client.readContract).toHaveBeenCalledWith(expect.objectContaining({ address: OLD_ROUTER, functionName: "rewardAddress", blockNumber: 100n }));
  });

  it("records the router alone when the receipt shows no trace of its callback, and reads on when the router does not answer", async () => {
    const { database, client, context } = createContext(369, (call) => {
      if (call.functionName === "rewardAddress") throw new Error("reverted");
      return answers()(call);
    });
    client.getTransactionReceipt.mockResolvedValue({ logs: [bridgedLog] });
    const event = createEvent({ token, recipient: ROUTER, value: 5n, messageId }, { transaction: { hash: hashOf("aa"), from: addressOf("f0"), to: BRIDGE }, log: { address: MEDIATOR_ON_PULSECHAIN, logIndex: 1 } });
    await callHandler("TokenMediator:TokensBridged", { event, context });
    expect(database.row(transfers, { messageId })).toMatchObject({ deliveryRouter: ROUTER, routerAmount: null, fee: null, feeSource: null });
  });

  it("falls back to the order of the transfers when the router answers no address, and allows a fee for a transaction with no to", async () => {
    const { database, client, context } = createContext(369, (call) => (call.functionName === "rewardAddress" ? "not an address" : answers()(call)));
    client.getTransactionReceipt.mockResolvedValue({
      logs: [bridgedLog, transferLog(2, ROUTER, REWARD, 3n), transferLog(3, ROUTER, RECIPIENT, 97n)],
    });
    const event = createEvent({ token, recipient: ROUTER, value: 100n, messageId }, { transaction: { hash: hashOf("aa"), from: addressOf("f0") }, log: { address: MEDIATOR_ON_PULSECHAIN, logIndex: 1 } });
    await callHandler("TokenMediator:TokensBridged", { event, context });
    expect(database.row(transfers, { messageId })).toMatchObject({ fee: 3n, received: 97n, deliverer: REWARD, feeSource: "logs" });
  });

  it("reads no receipt for a payment to an account that is not a router", async () => {
    const { database, client, context } = createContext(369, answers());
    await callHandler("TokenMediator:TokensBridged", { event: createEvent({ token, recipient: account, value: 41n, messageId }), context });
    expect(client.getTransactionReceipt).not.toHaveBeenCalled();
    expect(database.row(transfers, { messageId })).toMatchObject({ deliveryRouter: null, fee: null });
  });
});

describe("TokenMediator:NewTokenRegistered", () => {
  it("stores the bridged copy with its home token and the registration facts", async () => {
    const { database, context } = createContext(369, answers());
    await callHandler("TokenMediator:NewTokenRegistered", { event: createEvent({ nativeToken: native, bridgedToken: token }), context });
    expect(database.row(tokens, { chainId: 369, address: token })).toMatchObject({
      isBridgedCopy: true,
      homeChainId: 1,
      homeToken: native,
      registeredTransactionHash: hashOf("aa"),
      registeredBlockNumber: 100n,
      registeredTimestamp: 1_000n,
    });
  });
});

describe("the mediator has no fallback recipient and no claim records", () => {
  it.each(["FallbackUsed", "ClaimableRecorded", "Claimed"])("registers no handler for the deleted %s event", async (eventName) => {
    const { context } = createContext(369);
    await expect(callHandler(`TokenMediator:${eventName}`, { event: createEvent({ messageId }, { id: "e1" }), context })).rejects.toThrow(/no handler/);
  });
});

describe("TokenMediator:ReleaseFailed", () => {
  const name = "TokenMediator:ReleaseFailed";

  it("marks the message release-failed, which is final, and stores one event row for the recipient", async () => {
    const { database, context } = createContext(369);
    await callHandler(name, { event: createEvent({ token, recipient: account, value: 10n, messageId }, { id: "e1" }), context });
    expect(database.row(messages, { messageId })).toMatchObject({ sourceChainId: 1, destinationChainId: 369, releaseFailed: true });
    expect(database.row(releaseEvents, { id: "e1" })).toEqual({
      id: "e1",
      chainId: 369,
      kind: "release_failed",
      token,
      account,
      value: 10n,
      messageId,
      transactionHash: hashOf("aa"),
      blockNumber: 100n,
      timestamp: 1_000n,
    });
  });

  it("turns a delivered message into release_failed", async () => {
    const { database, context } = createContext(369);
    database.seed(messages, { ...sentMessageRow(messageId, 5n), deliveredBlockNumber: 110n, deliveredTimestamp: 1_100n, status: "delivered" });
    await callHandler(name, { event: createEvent({ token, recipient: account, value: 10n, messageId }, { id: "e1" }), context });
    expect(database.row(messages, { messageId })).toMatchObject({ releaseFailed: true, status: "release_failed" });
  });
});

describe("TokenMediator:CallbackFailed", () => {
  it("marks the message and stores one event row", async () => {
    const { database, context } = createContext(369);
    await callHandler("TokenMediator:CallbackFailed", { event: createEvent({ messageId, token, recipient: account }, { id: "e1" }), context });
    expect(database.row(messages, { messageId })).toMatchObject({ callbackFailed: true, sourceChainId: 1 });
    expect(database.row(releaseEvents, { id: "e1" })).toMatchObject({ kind: "callback_failed", account, value: null, messageId });
  });
});

describe("the bridged copy transfers", () => {
  const copy = {
    chainId: 369,
    address: token,
    name: "Tether",
    symbol: "USDT",
    decimals: 6,
    metadataRead: true,
    isBridgedCopy: true,
    homeChainId: 1,
    homeToken: native,
    registeredTransactionHash: null,
    registeredBlockNumber: null,
    registeredTimestamp: null,
  };
  const event = (value: bigint, blockNumber = 100n) =>
    createEvent({ value }, { log: { address: token }, block: { number: blockNumber, timestamp: blockNumber * 10n } });

  it("adds a mint to the minted total and to the supply, with the home of the token", async () => {
    const { database, context } = createContext(369);
    database.seed(tokens, copy);
    await callHandler("BridgedTokenMints:Transfer", { event: event(40n), context });
    expect(database.row(bridgedSupply, { chainId: 369, token })).toEqual({
      chainId: 369,
      token,
      nativeToken: native,
      homeChainId: 1,
      minted: 40n,
      burned: 0n,
      supply: 40n,
      updatedBlockNumber: 100n,
      updatedTimestamp: 1_000n,
    });
  });

  it("subtracts a burn from the supply and keeps the minted total", async () => {
    const { database, context } = createContext(369);
    database.seed(tokens, copy);
    await callHandler("BridgedTokenMints:Transfer", { event: event(40n), context });
    await callHandler("BridgedTokenBurns:Transfer", { event: event(15n, 200n), context });
    expect(database.row(bridgedSupply, { chainId: 369, token })).toMatchObject({
      minted: 40n,
      burned: 15n,
      supply: 25n,
      updatedBlockNumber: 200n,
      updatedTimestamp: 2_000n,
    });
  });

  it("refuses a transfer of a token that the mediator did not register, and writes nothing", async () => {
    const { database, context } = createContext(369);
    await expect(callHandler("BridgedTokenMints:Transfer", { event: event(40n), context })).rejects.toThrow(
      `transfer of ${token} on chain 369 before its registration`,
    );
    expect(database.writes).toEqual([]);
  });
});
