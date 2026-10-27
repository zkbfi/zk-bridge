import { describe, expect, it } from "vitest";
import { chainNameOf, parseMessageDetail } from "../../src/data/message-detail";
import { FIXTURE_PAIR } from "@terminal/data/fixtures";

const MESSAGE_ID = `0x${"AB".repeat(32)}`;
const TRANSACTION = `0x${"cd".repeat(32)}`;
const ADDRESS = "0x52908400098527886e0f7030069857d2e4169ee7";
const CHECKSUM = "0x52908400098527886E0F7030069857D2E4169EE7";
const OTHER = "0x2aaa0000000000000000000000000000000000a1";

const base = {
  messageId: MESSAGE_ID,
  kind: "message",
  status: "sent",
  direction: { sourceChainId: 1, destinationChainId: 369 },
  sender: ADDRESS,
  executor: ADDRESS,
  sent: { transactionHash: TRANSACTION, blockNumber: 12, timestamp: 100 },
};

describe("parseMessageDetail, the optional parts", () => {
  it("reads a minimal answer: lower case id, checksummed addresses, every optional part empty", () => {
    expect(parseMessageDetail(base)).toEqual({
      id: MESSAGE_ID.toLowerCase(),
      kind: "message",
      status: "sent",
      sourceChainId: 1,
      destinationChainId: 369,
      sender: CHECKSUM,
      executor: CHECKSUM,
      gasLimit: null,
      sentAt: 100,
      sentBlockNumber: 12,
      sourceTransactionHash: TRANSACTION,
      coveredByHeadSlot: null,
      coveredAt: null,
      deliveredAt: null,
      destinationTransactionHash: null,
      deliverySucceeded: null,
      executedBy: null,
      callbackFailed: false,
      releaseFailed: false,
      transfer: null,
      data: null,
    });
  });

  it("treats an absent covered or delivered part the same as a null one", () => {
    expect(parseMessageDetail({ ...base, covered: undefined, delivered: undefined, transfer: undefined })).toEqual(parseMessageDetail({ ...base, covered: null, delivered: null, transfer: null }));
  });

  it("reads a covered part, and gives null for a head slot or time that is not an integer", () => {
    expect(parseMessageDetail({ ...base, covered: { headSlot: 9, timestamp: 150 } })).toMatchObject({ coveredByHeadSlot: 9, coveredAt: 150 });
    expect(parseMessageDetail({ ...base, covered: { headSlot: "9", timestamp: null } })).toMatchObject({ coveredByHeadSlot: null, coveredAt: null });
  });

  it("reads a delivered part with all its fields", () => {
    const detail = parseMessageDetail({ ...base, delivered: { timestamp: 300, transactionHash: TRANSACTION.toUpperCase().replace("0X", "0x"), success: false, executedBy: ADDRESS } });
    expect(detail).toMatchObject({ deliveredAt: 300, destinationTransactionHash: TRANSACTION, deliverySucceeded: false, executedBy: CHECKSUM });
  });

  it("gives null for a delivered part whose hash, success flag or executor have the wrong type", () => {
    const detail = parseMessageDetail({ ...base, delivered: { timestamp: 300, transactionHash: 5, success: "yes", executedBy: 7 } });
    expect(detail).toMatchObject({ deliveredAt: 300, destinationTransactionHash: null, deliverySucceeded: null, executedBy: null });
  });

  it("reads the two flags only from the value true", () => {
    expect(parseMessageDetail({ ...base, callbackFailed: true, releaseFailed: true })).toMatchObject({ callbackFailed: true, releaseFailed: true });
    expect(parseMessageDetail({ ...base, callbackFailed: 1, releaseFailed: {} })).toMatchObject({ callbackFailed: false, releaseFailed: false });
  });

  it("carries no claim flag, even when an older answer sends one", () => {
    expect(parseMessageDetail({ ...base, claimableOutstanding: true })).not.toHaveProperty("claimableOutstanding");
  });

  it("carries no fallback flag, even when an older answer sends one", () => {
    expect(parseMessageDetail({ ...base, fallbackUsed: true })).not.toHaveProperty("fallbackUsed");
  });

  it("reads a kind of token and treats any other kind as a message", () => {
    expect(parseMessageDetail({ ...base, kind: "token" }).kind).toBe("token");
    expect(parseMessageDetail({ ...base, kind: "other" }).kind).toBe("message");
  });

  it("reads call data as lower case hex and refuses call data that is not hex", () => {
    expect(parseMessageDetail({ ...base, data: "0xABCD" }).data).toBe("0xabcd");
    expect(() => parseMessageDetail({ ...base, data: "zz" })).toThrow("The data is not hex.");
  });

  it("reads a gas limit, or null when it is not an integer", () => {
    expect(parseMessageDetail({ ...base, gasLimit: 90 }).gasLimit).toBe(90);
    expect(parseMessageDetail({ ...base, gasLimit: "90" }).gasLimit).toBeNull();
  });
});

describe("parseMessageDetail, refusals of bad input", () => {
  it("names the field that is wrong", () => {
    expect(() => parseMessageDetail(null)).toThrow("The message is not an object.");
    expect(() => parseMessageDetail({ ...base, direction: 1 })).toThrow("The direction is not an object.");
    expect(() => parseMessageDetail({ ...base, sent: [] })).toThrow("The sent is not an object.");
    expect(() => parseMessageDetail({ ...base, covered: 5 })).toThrow("The covered is not an object.");
    expect(() => parseMessageDetail({ ...base, delivered: "x" })).toThrow("The delivered is not an object.");
    expect(() => parseMessageDetail({ ...base, status: 4 })).toThrow("The status is not text.");
    expect(() => parseMessageDetail({ ...base, status: "teleported" })).toThrow('Unknown status "teleported".');
    expect(() => parseMessageDetail({ ...base, messageId: "nope" })).toThrow("The messageId is not hex.");
    expect(() => parseMessageDetail({ ...base, sender: "0x12" })).toThrow("The sender is not an address.");
    expect(() => parseMessageDetail({ ...base, sent: { ...base.sent, timestamp: "1" } })).toThrow("The sent.timestamp is not an integer.");
  });
});

describe("parseMessageDetail, the transfer", () => {
  const token = { address: ADDRESS, symbol: "USDC", decimals: 6, chainId: 1 };
  const transfer = { sourceToken: token, destinationToken: { ...token, chainId: 369, symbol: "zkbUSDC" }, recipient: ADDRESS, value: "10", deliveredValue: "9", hasCallback: true };

  it("reads every field of a transfer", () => {
    expect(parseMessageDetail({ ...base, transfer }).transfer).toEqual({
      sourceToken: { address: CHECKSUM, symbol: "USDC", decimals: 6, chainId: 1 },
      destinationToken: { address: CHECKSUM, symbol: "zkbUSDC", decimals: 6, chainId: 369 },
      recipient: CHECKSUM,
      value: 10n,
      deliveredValue: 9n,
      hasCallback: true,
    });
  });

  it("carries no fallback recipient, even when an older answer sends one", () => {
    expect(parseMessageDetail({ ...base, transfer: { ...transfer, fallbackRecipient: OTHER } }).transfer).not.toHaveProperty("fallbackRecipient");
  });

  it("gives no delivered value and no callback when the answer has none", () => {
    const { deliveredValue: _gone, hasCallback: _flag, ...rest } = transfer;
    expect(parseMessageDetail({ ...base, transfer: rest }).transfer).toMatchObject({ deliveredValue: null, hasCallback: false });
    expect(parseMessageDetail({ ...base, transfer: { ...rest, deliveredValue: null, hasCallback: "yes" } }).transfer).toMatchObject({ deliveredValue: null, hasCallback: false });
  });

  it("names a symbol from the address and assumes 18 decimals when the token did not answer", () => {
    const bare = { address: ADDRESS, chainId: 1 };
    const parsed = parseMessageDetail({ ...base, transfer: { ...transfer, sourceToken: bare } }).transfer;
    expect(parsed?.sourceToken).toEqual({ address: CHECKSUM, symbol: `${CHECKSUM.slice(0, 8)}…`, decimals: 18, chainId: 1 });
  });

  it("refuses a transfer with a bad token, amount or chain", () => {
    expect(() => parseMessageDetail({ ...base, transfer: { ...transfer, sourceToken: null } })).toThrow("The transfer.sourceToken is not an object.");
    expect(() => parseMessageDetail({ ...base, transfer: { ...transfer, destinationToken: { ...token, address: "x" } } })).toThrow("The transfer.destinationToken.address is not an address.");
    expect(() => parseMessageDetail({ ...base, transfer: { ...transfer, sourceToken: { ...token, chainId: "1" } } })).toThrow("The transfer.sourceToken.chainId is not an integer.");
    expect(() => parseMessageDetail({ ...base, transfer: { ...transfer, deliveredValue: 9 } })).toThrow("The amount deliveredValue is not a decimal string.");
    expect(() => parseMessageDetail({ ...base, transfer: 5 })).toThrow("The transfer is not an object.");
  });
});

describe("chainNameOf", () => {
  it("names either chain of the pair and falls back to the chain number", () => {
    expect(chainNameOf(FIXTURE_PAIR, FIXTURE_PAIR.first.chainId)).toBe(FIXTURE_PAIR.first.name);
    expect(chainNameOf(FIXTURE_PAIR, FIXTURE_PAIR.second.chainId)).toBe(FIXTURE_PAIR.second.name);
    expect(chainNameOf(FIXTURE_PAIR, 31337)).toBe("chain 31337");
  });
});
