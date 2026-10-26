import { beforeAll, describe, expect, it } from "vitest";
import {
  bridgedSupply,
  claimEvents,
  claimables,
  escrow,
  feeBalances,
  feeEvents,
  feeTerms,
  messages,
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

/** Answers the reads of the handlers: the token metadata, the escrow, the fee terms and the native token behind a token. */
const answers =
  (behind: string = ZERO) =>
  ({ functionName }: ReadCall) => {
    const values: Record<string, unknown> = {
      name: "Tether",
      symbol: "USDT",
      decimals: 6,
      nativeTokenAddress: behind,
      mediatorBalance: 500n,
      accruedFees: 7n,
      currentFeeRate: 1_000_000_000_000_000n,
      feeRecipient: other,
    };
    return values[functionName];
  };

const escrowRow = (chainId: number, tokenAddress: string, blockNumber = 100n) => ({
  chainId,
  token: tokenAddress,
  balance: 500n,
  accruedFees: 7n,
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

describe("TokenMediator:FallbackUsed", () => {
  it("marks the message and stores one event row with the fallback address", async () => {
    const { database, context } = createContext(369);
    const id = "event-1";
    await callHandler("TokenMediator:FallbackUsed", {
      event: createEvent({ messageId, token, recipient: account, fallbackRecipient: other }, { id }),
      context,
    });
    expect(database.row(messages, { messageId })).toMatchObject({ sourceChainId: 1, destinationChainId: 369, fallbackUsed: true });
    expect(database.row(claimEvents, { id })).toEqual({
      id,
      chainId: 369,
      kind: "fallback_used",
      token,
      account,
      fallbackRecipient: other,
      value: null,
      messageId,
      transactionHash: hashOf("aa"),
      blockNumber: 100n,
      timestamp: 1_000n,
    });
  });
});

describe("TokenMediator:ClaimableRecorded", () => {
  const name = "TokenMediator:ClaimableRecorded";

  it("marks the message claimable and opens a claimable balance", async () => {
    const { database, context } = createContext(369);
    await callHandler(name, { event: createEvent({ token, account, value: 10n, messageId }, { id: "e1" }), context });
    expect(database.row(messages, { messageId })).toMatchObject({
      claimableOutstanding: true,
      claimableToken: token,
      claimableAccount: account,
    });
    expect(database.row(claimables, { chainId: 369, token, account })).toEqual({
      chainId: 369,
      token,
      account,
      outstanding: 10n,
      recordedTotal: 10n,
      claimedTotal: 0n,
    });
    expect(database.row(claimEvents, { id: "e1" })).toMatchObject({ kind: "claimable_recorded", value: 10n, fallbackRecipient: null, messageId });
  });

  it("adds a second release to the outstanding and the recorded totals and keeps the claimed total", async () => {
    const { database, context } = createContext(369);
    database.seed(claimables, { chainId: 369, token, account, outstanding: 5n, recordedTotal: 20n, claimedTotal: 15n });
    await callHandler(name, { event: createEvent({ token, account, value: 10n, messageId }, { id: "e2" }), context });
    expect(database.row(claimables, { chainId: 369, token, account })).toMatchObject({ outstanding: 15n, recordedTotal: 30n, claimedTotal: 15n });
  });
});

describe("TokenMediator:Claimed", () => {
  const name = "TokenMediator:Claimed";

  it("zeroes the balance, adds the claim to the claimed total and keeps the recorded total", async () => {
    const { database, context } = createContext(369, answers());
    database.seed(claimables, { chainId: 369, token, account, outstanding: 10n, recordedTotal: 30n, claimedTotal: 5n });
    database.queueSqlRows([]);
    await callHandler(name, { event: createEvent({ token, account, value: 10n }, { id: "e1" }), context });
    expect(database.row(claimables, { chainId: 369, token, account })).toEqual({
      chainId: 369,
      token,
      account,
      outstanding: 0n,
      recordedTotal: 30n,
      claimedTotal: 15n,
    });
    expect(database.row(claimEvents, { id: "e1" })).toMatchObject({ kind: "claimed", value: 10n, messageId: null });
    expect(database.row(escrow, { chainId: 369, token })).toEqual(escrowRow(369, token));
  });

  it("uses the claimed value as the recorded total when no record exists", async () => {
    const { database, context } = createContext(369, answers());
    database.queueSqlRows([]);
    await callHandler(name, { event: createEvent({ token, account, value: 10n }, { id: "e1" }), context });
    expect(database.row(claimables, { chainId: 369, token, account })).toMatchObject({ outstanding: 0n, recordedTotal: 10n, claimedTotal: 10n });
  });

  it("clears the claimable flag of each waiting message and stamps the claim time", async () => {
    const { database, context } = createContext(369, answers());
    database.seed(messages, {
      ...sentMessageRow(messageId, 5n),
      deliveredSuccess: true,
      deliveredTimestamp: 1_100n,
      claimableOutstanding: true,
      claimableToken: token,
      claimableAccount: account,
      status: "claimable",
    });
    database.queueSqlRows([{ messageId }]);
    await callHandler(name, { event: createEvent({ token, account, value: 10n }, { id: "e1" }), context });
    expect(database.row(messages, { messageId })).toMatchObject({ claimableOutstanding: false, claimedTimestamp: 1_000n, status: "delivered" });
  });
});

describe("TokenMediator:CallbackFailed", () => {
  it("marks the message and stores one event row", async () => {
    const { database, context } = createContext(369);
    await callHandler("TokenMediator:CallbackFailed", { event: createEvent({ messageId, token, recipient: account }, { id: "e1" }), context });
    expect(database.row(messages, { messageId })).toMatchObject({ callbackFailed: true, sourceChainId: 1 });
    expect(database.row(claimEvents, { id: "e1" })).toMatchObject({ kind: "callback_failed", account, value: null, fallbackRecipient: null, messageId });
  });
});

describe("TokenMediator:FeeCharged", () => {
  const name = "TokenMediator:FeeCharged";

  it("reads the rate and the recipient from the mediator of the chain and stores them as the terms", async () => {
    const { database, client, context } = createContext(369, answers());
    await callHandler(name, { event: createEvent({ token, fee: 3n, direction: 0 }, { id: "e1" }), context });
    const reads = client.readContract.mock.calls.map(([call]) => [call.address, call.functionName]);
    expect(reads).toContainEqual([MEDIATOR_ON_PULSECHAIN, "currentFeeRate"]);
    expect(reads).toContainEqual([MEDIATOR_ON_PULSECHAIN, "feeRecipient"]);
    expect(reads).not.toContainEqual([MEDIATOR_ON_ETHEREUM, "currentFeeRate"]);
    expect(database.row(feeTerms, { chainId: 369 })).toEqual({ chainId: 369, rate: 1_000_000_000_000_000n, recipient: other });
  });

  it("stores an outgoing fee as an event and in the balance, and refreshes the escrow", async () => {
    const { database, context } = createContext(369, answers());
    await callHandler(name, { event: createEvent({ token, fee: 3n, direction: 0 }, { id: "e1" }), context });
    expect(database.row(feeEvents, { id: "e1" })).toEqual({
      id: "e1",
      chainId: 369,
      kind: "charged_outgoing",
      token,
      amount: 3n,
      recipient: null,
      rate: null,
      transactionHash: hashOf("aa"),
      blockNumber: 100n,
      timestamp: 1_000n,
    });
    expect(database.row(feeBalances, { chainId: 369, token })).toEqual({ chainId: 369, token, charged: 3n, collected: 0n, accrued: 3n });
    expect(database.row(escrow, { chainId: 369, token })).toEqual(escrowRow(369, token));
  });

  it("names an incoming fee and adds it to the earlier charges, keeping the collected total", async () => {
    const { database, context } = createContext(369, answers());
    database.seed(feeBalances, { chainId: 369, token, charged: 10n, collected: 4n, accrued: 6n });
    await callHandler(name, { event: createEvent({ token, fee: 3n, direction: 1 }, { id: "e1" }), context });
    expect(database.row(feeEvents, { id: "e1" })).toMatchObject({ kind: "charged_incoming" });
    expect(database.row(feeBalances, { chainId: 369, token })).toEqual({ chainId: 369, token, charged: 13n, collected: 4n, accrued: 9n });
  });
});

describe("TokenMediator:FeesCollected", () => {
  const name = "TokenMediator:FeesCollected";

  it("stores the collection and subtracts it from the accrued fees", async () => {
    const { database, context } = createContext(369, answers());
    database.seed(feeBalances, { chainId: 369, token, charged: 10n, collected: 4n, accrued: 6n });
    await callHandler(name, { event: createEvent({ token, feeRecipient: other, amount: 6n }, { id: "e1" }), context });
    expect(database.row(feeEvents, { id: "e1" })).toMatchObject({ kind: "collected", recipient: other, amount: 6n, rate: null });
    expect(database.row(feeBalances, { chainId: 369, token })).toEqual({ chainId: 369, token, charged: 10n, collected: 10n, accrued: 0n });
    expect(database.row(escrow, { chainId: 369, token })).toEqual(escrowRow(369, token));
  });

  it("takes the collected amount as the charged amount when no charge was seen, so the accrued fees are zero", async () => {
    const { database, context } = createContext(369, answers());
    await callHandler(name, { event: createEvent({ token, feeRecipient: other, amount: 6n }, { id: "e1" }), context });
    expect(database.row(feeBalances, { chainId: 369, token })).toEqual({ chainId: 369, token, charged: 6n, collected: 6n, accrued: 0n });
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
