import { describe, expect, it } from "vitest";
import { parseDeliveryCostReport } from "../src/index.js";
import {
  AFFIRMATION_COMPLETED_SELECTOR,
  averageRoundingHalfUp,
  buildDeliveryCostReport,
  classifyDelivery,
  countDeliveriesInReceipt,
  isSingleDelivery,
  percentileNearestRank,
  type ReceiptLog,
} from "../src/delivery-cost.js";
import { parseDeliveryCostSettings } from "../src/delivery-cost-settings.js";

const bridge = "0x00000000000000000000000000000000000000b1" as const;
const other = "0x00000000000000000000000000000000000000c2" as const;
const completed: ReceiptLog = { address: bridge, topics: [AFFIRMATION_COMPLETED_SELECTOR] };
const settings = parseDeliveryCostSettings({}, [369]);
const range = (count: number): bigint[] => Array.from({ length: count }, (_, index) => BigInt(index + 1));
const emptySamples = { token_callback: [], token: [], message: [] };

describe("receipt attribution", () => {
  it("knows the event selector of the bridge interface", () => {
    expect(AFFIRMATION_COMPLETED_SELECTOR).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("accepts a receipt with one delivery log and ignores other logs and other contracts", () => {
    const logs: ReceiptLog[] = [{ address: bridge, topics: ["0x1234"] }, { address: other, topics: [AFFIRMATION_COMPLETED_SELECTOR] }, completed];
    expect(countDeliveriesInReceipt(logs, bridge)).toBe(1);
    expect(isSingleDelivery(logs, bridge)).toBe(true);
  });

  it("refuses a batch, because its gas cannot be split between deliveries", () => {
    expect(isSingleDelivery([completed, completed], bridge)).toBe(false);
  });

  it("refuses a receipt with no delivery log", () => {
    expect(isSingleDelivery([], bridge)).toBe(false);
  });

  it("matches the bridge address without regard to letter case", () => {
    expect(isSingleDelivery([{ address: bridge.toUpperCase().replace("0X", "0x") as `0x${string}`, topics: [AFFIRMATION_COMPLETED_SELECTOR] }], bridge)).toBe(true);
  });
});

describe("classifyDelivery", () => {
  it("calls a token message with a callback token_callback", () => {
    expect(classifyDelivery({ messageKind: "token", sendIndexed: true, hasCallback: true })).toBe("token_callback");
  });

  it("calls a token message without a callback token", () => {
    expect(classifyDelivery({ messageKind: "token", sendIndexed: true, hasCallback: false })).toBe("token");
  });

  it("calls any other indexed message a message", () => {
    expect(classifyDelivery({ messageKind: "message", sendIndexed: true, hasCallback: null })).toBe("message");
  });

  it("cannot classify a delivery whose send is not indexed, because its kind is only the placeholder", () => {
    expect(classifyDelivery({ messageKind: "message", sendIndexed: false, hasCallback: null })).toBeNull();
  });

  it("cannot classify a token message that has no transfer row", () => {
    expect(classifyDelivery({ messageKind: "token", sendIndexed: true, hasCallback: null })).toBeNull();
  });
});

describe("averageRoundingHalfUp", () => {
  it("returns null for no samples", () => expect(averageRoundingHalfUp([])).toBeNull());
  it("returns the sample for one sample", () => expect(averageRoundingHalfUp([7n])).toBe(7n));
  it("rounds half up", () => {
    expect(averageRoundingHalfUp([1n, 2n])).toBe(2n);
    expect(averageRoundingHalfUp([1n, 1n, 2n])).toBe(1n);
    expect(averageRoundingHalfUp([1n, 2n, 2n])).toBe(2n);
  });
  it("is exact beyond 2^53", () => {
    const big = 2n ** 80n + 1n;
    expect(averageRoundingHalfUp([big, big])).toBe(big);
  });
});

describe("percentileNearestRank", () => {
  it("returns null for no samples", () => expect(percentileNearestRank([], 90)).toBeNull());
  it("returns the only sample, never zero", () => expect(percentileNearestRank([5n], 90)).toBe(5n));
  it("takes rank 9 of 10 samples", () => expect(percentileNearestRank(range(10), 90)).toBe(9n));
  it("rounds the rank up to 10 of 11 samples", () => expect(percentileNearestRank(range(11), 90)).toBe(10n));
  it("sorts the samples first", () => expect(percentileNearestRank([9n, 1n, 5n, 3n, 7n, 2n, 8n, 4n, 6n, 10n], 90)).toBe(9n));
  it("does not truncate a small list to rank zero", () => expect(percentileNearestRank([4n, 8n], 1)).toBe(4n));
  it("keeps big values exact", () => {
    const big = 10n ** 30n;
    expect(percentileNearestRank([big, big + 1n], 100)).toBe(big + 1n);
  });
  it("rejects a percentile outside 1 to 100", () => {
    expect(() => percentileNearestRank([1n], 0)).toThrow(RangeError);
    expect(() => percentileNearestRank([1n], 101)).toThrow(RangeError);
  });
});

describe("buildDeliveryCostReport", () => {
  it("answers with the default and says so when there are no samples", () => {
    const report = buildDeliveryCostReport({ chainId: 369, samples: emptySamples, baseFee: null, settings });
    expect(report.kinds.token.isDefault).toBe(true);
    expect(report.kinds.token.defaultGas).toBe("550000");
    expect(report.kinds.token.averageGas).toBeNull();
    expect(report.kinds.token.p90Gas).toBeNull();
    expect(report.baseFee).toEqual({ wei: null, blockNumber: null, timestamp: null });
    expect(report.proofCost.wei).toBeNull();
    expect(parseDeliveryCostReport(report)).toEqual(report);
  });

  it("reports one sample as both the average and the 90th percentile", () => {
    const report = buildDeliveryCostReport({ chainId: 369, samples: { ...emptySamples, token: [300_000n] }, baseFee: null, settings });
    expect(report.kinds.token).toMatchObject({ sampleCount: 1, averageGas: "300000", p90Gas: "300000", isDefault: false });
    expect(report.kinds.message.isDefault).toBe(true);
  });

  it("keeps big gas values exact as text", () => {
    const big = 2n ** 70n;
    const report = buildDeliveryCostReport({ chainId: 369, samples: { ...emptySamples, message: [big] }, baseFee: null, settings });
    expect(report.kinds.message.p90Gas).toBe(big.toString());
  });

  it("carries the latest base fee and the proof cost in wei when a coin price is set", () => {
    const priced = parseDeliveryCostSettings({ EXPLORER_NATIVE_COIN_PRICE_USD_369: "0.00005" }, [369]);
    const report = buildDeliveryCostReport({
      chainId: 369,
      samples: emptySamples,
      baseFee: { blockNumber: 100n, timestamp: 1_700_000_000n, baseFeePerGas: 12_345n },
      settings: priced,
    });
    expect(report.baseFee).toEqual({ wei: "12345", blockNumber: 100, timestamp: 1_700_000_000 });
    expect(report.proofCost).toMatchObject({ usd: "0.02", nativeCoinPriceUsd: "0.00005", wei: (400n * 10n ** 18n).toString(), isEstimate: true });
    expect(parseDeliveryCostReport(report)).toEqual(report);
  });

  it("gives a null base fee when the block reported none", () => {
    const report = buildDeliveryCostReport({
      chainId: 369,
      samples: emptySamples,
      baseFee: { blockNumber: 1n, timestamp: 2n, baseFeePerGas: null },
      settings,
    });
    expect(report.baseFee).toEqual({ wei: null, blockNumber: 1, timestamp: 2 });
  });
});

describe("a base fee row without a base fee", () => {
  it("reports no wei for a chain that has no base fee, but keeps the block and the time", () => {
    const report = buildDeliveryCostReport({
      chainId: 369,
      samples: emptySamples,
      baseFee: { blockNumber: 7n, timestamp: 1_700_000_000n, baseFeePerGas: null },
      settings,
    });
    expect(report.baseFee).toEqual({ wei: null, blockNumber: 7, timestamp: 1_700_000_000 });
  });
});
