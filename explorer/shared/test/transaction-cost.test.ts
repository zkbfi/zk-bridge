import { describe, expect, it } from "vitest";
import { costView, costViewSchema, messageCostsSchema, transactionCostRow } from "../src/transaction-cost.js";

const E18 = 10n ** 18n;
const base = { chainId: 369, transactionHash: "0xaa" as const, blockNumber: 100n, timestamp: 1_000n, gasUsed: 200_000n, effectiveGasPrice: 1_000_000n * 10n ** 9n };

describe("a transaction's cost", () => {
  it("is gas used × effective gas price in wei, and in micro-dollars at the price read at a named block", () => {
    // 200,000 gas × 1,000,000 gwei = 200 PLS; at $0.00003 that is $0.006.
    const row = transactionCostRow({ ...base, price: { usdE18: 30_000_000_000_000n, block: 100n, pool: null, source: "pulsex-pls-usd" } });
    expect(row).toEqual({ ...base, costWei: 200n * E18, usdPerNativeE18: 30_000_000_000_000n, priceBlock: 100n, priceSource: "pulsex-pls-usd", costMicroUsd: 6_000n });
  });

  it("keeps the wei and leaves the dollars empty without a price (testnets)", () => {
    expect(transactionCostRow({ ...base, chainId: 943, price: null })).toMatchObject({ costWei: 200n * E18, usdPerNativeE18: null, priceBlock: null, priceSource: null, costMicroUsd: null });
  });
});

describe("the cost view", () => {
  const hash = `0x${"ab".repeat(32)}` as const;
  it("writes every integer as a decimal string, with the coin's price in micro-dollars and at 1e18", () => {
    const row = transactionCostRow({ ...base, transactionHash: hash, price: { usdE18: 3_000n * E18, block: 99n, pool: null, source: "pulsex-weth-copy" } });
    const view = costView(row);
    expect(view).toEqual({
      chainId: 369,
      hash,
      block: "100",
      gasUsed: "200000",
      effectiveGasPriceWei: "1000000000000000",
      costWei: "200000000000000000000",
      costMicroUsd: "600000000000",
      nativeUsd: { usd: "3000000000", usdE18: "3000000000000000000000", source: "pulsex-weth-copy", priceBlock: "99" },
    });
    expect(costViewSchema.parse(view)).toEqual(view);
    expect(costView(transactionCostRow({ ...base, transactionHash: hash, price: null }))).toMatchObject({ costMicroUsd: null, nativeUsd: null });
    expect(costView(null)).toBeNull();
  });

  it("parses a message's costs, with the proof's covered count", () => {
    const sent = costView(transactionCostRow({ ...base, transactionHash: hash, price: null }))!;
    expect(messageCostsSchema.parse({ sent, delivered: null, proof: { ...sent, coveredMessages: 3 } }).proof?.coveredMessages).toBe(3);
    expect(() => messageCostsSchema.parse({ sent: { ...sent, block: "x" }, delivered: null, proof: null })).toThrow();
  });
});
