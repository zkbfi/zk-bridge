import { describe, expect, it } from "vitest";
import {
  amountOf,
  escrowView,
  feedItemView,
  indexTokens,
  numberOf,
  supplyView,
  tokenKey,
  tokenView,
} from "../src/api-views.js";
import { addressOf, hashOf, sentMessageRow } from "./support/fixtures.js";

const token = addressOf("aa");
const native = addressOf("bb");
const tokenRow = {
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
const index = indexTokens([tokenRow]);

describe("numberOf and amountOf", () => {
  it("turn a bigint into a number or a decimal string and keep null and undefined as null", () => {
    expect(numberOf(5n)).toBe(5);
    expect(numberOf(0n)).toBe(0);
    expect(numberOf(null)).toBeNull();
    expect(numberOf(undefined)).toBeNull();
    expect(amountOf(10n ** 30n)).toBe("1000000000000000000000000000000");
    expect(amountOf(0n)).toBe("0");
    expect(amountOf(null)).toBeNull();
    expect(amountOf(undefined)).toBeNull();
  });
});

describe("the token index", () => {
  it("keys a token by chain and lowercase address, so a checksummed address finds the row", () => {
    expect(tokenKey(369, "0xABCDEF0000000000000000000000000000000001")).toBe("369:0xabcdef0000000000000000000000000000000001");
    expect(index.get(tokenKey(369, token.toUpperCase().replace("0X", "0x")))).toBe(tokenRow);
  });

  it("does not mix the same address on two chains", () => {
    expect(index.get(tokenKey(1, token))).toBeUndefined();
  });
});

describe("tokenView", () => {
  it("answers null for no address", () => {
    expect(tokenView(369, null, index)).toBeNull();
  });

  it("shows the stored facts of a known token", () => {
    expect(tokenView(369, token, index)).toEqual({
      chainId: 369,
      address: token,
      symbol: "USDT",
      name: "Tether",
      decimals: 6,
      metadataRead: true,
      isBridgedCopy: true,
      homeChainId: 1,
      homeToken: native,
    });
  });

  it("shows an unknown token with null facts and metadataRead false, because nothing was read", () => {
    expect(tokenView(1, token, index)).toEqual({
      chainId: 1,
      address: token,
      symbol: null,
      name: null,
      decimals: null,
      metadataRead: false,
      isBridgedCopy: null,
      homeChainId: null,
      homeToken: null,
    });
  });
});

describe("feedItemView", () => {
  const id = hashOf("ab");
  const sent = sentMessageRow(id, 100n);
  const transfer = {
    messageId: id,
    sourceChainId: 1,
    destinationChainId: 369,
    sourceToken: native,
    destinationToken: token,
    sender: addressOf("11"),
    recipient: addressOf("22"),
    value: 42n,
    deliveredValue: null,
    paidTo: null,
    handler: "handleBridgedTokens",
    deploysCopy: false,
    hasCallback: false,
    sourceIsNative: true,
    sentTimestamp: 1_000n,
  };

  it("shows the log index of the send, so the evidence of the message can find its log", () => {
    expect(feedItemView({ ...sent, sentLogIndex: 9 }, null, index).sentLogIndex).toBe(9);
    expect(feedItemView({ ...sent, sentLogIndex: null }, null, index).sentLogIndex).toBeNull();
  });

  it("shows a send with no cover, no delivery and no transfer as nulls", () => {
    const view = feedItemView({ ...sent, sentTransactionHash: hashOf("cd") }, null, index);
    expect(view).toMatchObject({
      messageId: id,
      kind: "token",
      status: "sent",
      direction: { sourceChainId: 1, destinationChainId: 369, label: "1>369" },
      sent: { transactionHash: hashOf("cd"), blockNumber: 100, timestamp: 1_000 },
      covered: null,
      delivered: null,
      transfer: null,
      callbackFailed: false,
      releaseFailed: false,
    });
  });

  it("shows no send block for a message whose send is not indexed yet", () => {
    expect(feedItemView({ ...sent, sentTimestamp: null }, null, index).sent).toBeNull();
  });

  it("shows the cover and the delivery when they are stored", () => {
    const view = feedItemView(
      {
        ...sent,
        coveredByHeadSlot: 77n,
        coveredAtTimestamp: 1_500n,
        deliveredTimestamp: 2_000n,
        deliveredTransactionHash: hashOf("ef"),
        deliveredBlockNumber: 55n,
        executedBy: addressOf("f0"),
      },
      null,
      index,
    );
    expect(view.covered).toEqual({ headSlot: 77, timestamp: 1_500 });
    expect(view.delivered).toEqual({
      transactionHash: hashOf("ef"),
      blockNumber: 55,
      timestamp: 2_000,
      executedBy: addressOf("f0"),
    });
  });

  it("shows the transfer with amounts as strings and tokens with their facts, each on its own chain", () => {
    const view = feedItemView(sent, transfer, index);
    expect(view.transfer).toMatchObject({
      sourceToken: { chainId: 1, address: native, symbol: null },
      destinationToken: { chainId: 369, address: token, symbol: "USDT" },
      value: "42",
      deliveredValue: null,
      paidTo: null,
      handler: "handleBridgedTokens",
      sourceIsNative: true,
    });
  });

  it("names no fallback: the item has no fallbackUsed and the transfer has no fallbackRecipient", () => {
    const view = feedItemView(sent, transfer, index);
    expect(view).not.toHaveProperty("fallbackUsed");
    expect(view.transfer).not.toHaveProperty("fallbackRecipient");
  });
});

describe("escrowView and supplyView", () => {
  it("show the amounts as strings and the token with its facts", () => {
    expect(
      escrowView({ chainId: 369, token, balance: 500n, updatedBlockNumber: 9n, updatedTimestamp: 90n }, index),
    ).toEqual({
      chainId: 369,
      token: tokenView(369, token, index),
      balance: "500",
      updatedBlockNumber: 9,
      updatedTimestamp: 90,
    });
    expect(
      supplyView(
        { chainId: 369, token, nativeToken: native, homeChainId: 1, minted: 40n, burned: 15n, supply: 25n, updatedBlockNumber: 9n, updatedTimestamp: 90n },
        index,
      ),
    ).toEqual({
      chainId: 369,
      token: tokenView(369, token, index),
      nativeToken: native,
      homeChainId: 1,
      minted: "40",
      burned: "15",
      supply: "25",
      updatedBlockNumber: 9,
      updatedTimestamp: 90,
    });
  });
});
