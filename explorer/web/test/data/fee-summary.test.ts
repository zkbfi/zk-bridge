import { describe, expect, it } from "vitest";
import { feePercentText, feeSummaryParts, feeSummaryText } from "../../src/data/fee-summary";
import { feeLineOf } from "../../src/bridge/activity-model";
import type { FeedItem, TokenInfo } from "@terminal/model/types";

const E18 = 10n ** 18n;
const input = { sent: (123n * E18) / 10n, sentDecimals: 18, sentSymbol: "tTKN", fee: (123n * E18) / 10_000n, received: (122_877n * E18) / 10_000n, decimals: 18, symbol: "zbtTKN" };

describe("the delivery fee line", () => {
  it("says what was sent, the fee with its share, and what was received, each with its token", () => {
    expect(feeSummaryText(input)).toBe("12.3 tTKN sent · 0.0123 zbtTKN fee (0.1%) · 12.2877 zbtTKN received");
  });

  it("says when the fee or the received amount is not recorded", () => {
    expect(feeSummaryText({ ...input, fee: null, received: null })).toBe("12.3 tTKN sent · fee not recorded · received amount not recorded");
    expect(feeSummaryParts({ ...input, received: null })).toMatchObject({ percent: null, received: null });
  });

  it("gives the share with up to three significant digits, and none without a whole", () => {
    expect(feePercentText(1n, 99n)).toBe("1%");
    expect(feePercentText(1n, 2n)).toBe("33.3%");
    expect(feePercentText(0n, 100n)).toBe("0%");
    expect(feePercentText(0n, 0n)).toBeNull();
    expect(feePercentText(null, 5n)).toBeNull();
    expect(feeSummaryText({ ...input, fee: 0n, received: 0n })).toBe("12.3 tTKN sent · 0 zbtTKN fee · 0 zbtTKN received");
  });
});

describe("feeLineOf, in Activity", () => {
  const token = { address: "0x0000000000000000000000000000000000000033", symbol: "tTKN", decimals: 18, side: "first", counterpart: null, isBridgedCopy: false } as unknown as TokenInfo;
  const copy = { ...token, symbol: "zbtTKN", side: "second", isBridgedCopy: true } as unknown as TokenInfo;
  const item = { token, amount: input.sent, delivery: { token: copy, fee: input.fee, received: input.received } } as unknown as FeedItem;

  it("shows the line for a router delivery whose fee the indexer read", () => {
    expect(feeLineOf(item)).toMatch(/^12\.3 tTKN sent · 0\.0123 \S+ fee \(0\.1%\) · 12\.2877 \S+ received$/);
  });

  it("falls back to the sent token when the answer names no destination token", () => {
    expect(feeLineOf({ ...item, delivery: { token: null, fee: 0n, received: input.sent } })).toBe("12.3 tTKN sent · 0 tTKN fee (0%) · 12.3 tTKN received");
  });

  it("shows nothing without a router delivery, an unknown fee, or no amount", () => {
    expect(feeLineOf({ ...item, delivery: undefined })).toBeNull();
    expect(feeLineOf({ ...item, delivery: null })).toBeNull();
    expect(feeLineOf({ ...item, delivery: { token: copy, fee: null, received: null } })).toBeNull();
    expect(feeLineOf({ ...item, token: null })).toBeNull();
    expect(feeLineOf({ ...item, amount: null })).toBeNull();
  });
});
